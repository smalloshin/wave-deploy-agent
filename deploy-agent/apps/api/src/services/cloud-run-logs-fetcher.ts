/**
 * Cloud Run container logs fetcher (R53)
 *
 * Why this exists:
 *   When Cloud Run deploy fails with the generic timeout error
 *   ("container failed to start and listen on PORT=N within the allocated
 *   timeout"), the deploy-worker only had `error.message` to feed the LLM
 *   diagnosis. The LLM saw "container didn't bind to port" + Dockerfile
 *   contents and concluded "probably FastAPI startup failure, please debug
 *   locally" — generic, not actionable.
 *
 *   Meanwhile, the actual Python traceback was sitting in Cloud Run's
 *   container stderr (e.g. `RuntimeError("erp-jwt-secret is required but
 *   not available from Secret Manager")` for wavenet-ai-gateway-backend).
 *   Operators had to manually `gcloud logging read` to see the real cause.
 *
 *   R53 closes that gap: when Cloud Run deploy fails, we extract the
 *   service+revision name from the error message (Cloud Run's error
 *   includes a `Logs URL: ...` with both labels), call Cloud Logging API
 *   directly, fetch the most recent container stderr+stdout entries, and
 *   prepend them to the LLM diagnosis input. Now the LLM sees the actual
 *   traceback and can give a precise root cause.
 *
 * Pure helpers (testable):
 *   - extractCloudRunMetaFromError(errorMsg) → { serviceName?, revisionName? }
 *   - formatLogEntries(entries, maxBytes) → string
 *
 * Async helper:
 *   - fetchContainerLogs(serviceName, revisionName, gcpProject, lookbackMs)
 *     → string (or null on failure — never throws)
 *
 * Permission requirement: caller must have `roles/logging.viewer` (or
 * equivalent) for the GCP project. Cloud Run service accounts typically
 * already have this. On permission denied, returns null silently — log
 * fetch is best-effort, never blocks the failure handling path.
 */

/** Extracted Cloud Run metadata from a deploy error message. */
export interface CloudRunErrorMeta {
  serviceName?: string;
  revisionName?: string;
}

/**
 * Extract Cloud Run service + revision name from a deploy failure error
 * message. Cloud Run's "container failed to start" errors include a
 * `Logs URL: https://console.cloud.google.com/logs/viewer?...resource.labels
 * .service_name="X"...resource.labels.revision_name="Y"...` block which we
 * regex out here.
 *
 * Pure function: input → output. Returns empty object if neither is found.
 */
export function extractCloudRunMetaFromError(errorMsg: string): CloudRunErrorMeta {
  if (typeof errorMsg !== 'string' || errorMsg.length === 0) return {};

  const meta: CloudRunErrorMeta = {};

  // service_name="X"  (URL-encoded form in Logs URL: %22X%22)
  const svcMatch =
    errorMsg.match(/service_name(?:=|%3D)(?:"|%22)([a-z0-9-]+)(?:"|%22)/i) ||
    errorMsg.match(/service_name[=:]?\s*["']([a-z0-9-]+)["']/i);
  if (svcMatch) meta.serviceName = svcMatch[1];

  // revision_name="X"
  const revMatch =
    errorMsg.match(/revision_name(?:=|%3D)(?:"|%22)([a-z0-9-]+)(?:"|%22)/i) ||
    errorMsg.match(/revision_name[=:]?\s*["']([a-z0-9-]+)["']/i);
  if (revMatch) meta.revisionName = revMatch[1];

  return meta;
}

/** Subset of Cloud Logging API entry fields we care about. */
export interface CloudLogEntry {
  textPayload?: string;
  jsonPayload?: Record<string, unknown>;
  timestamp?: string;
  severity?: string;
}

/**
 * Format Cloud Logging entries into a single string for the LLM prompt.
 *
 * Pure function: takes a list of entries, returns a `[timestamp severity]
 * text` formatted string, oldest first (so traceback reads top-to-bottom).
 * Truncates total output at maxBytes from the END (we want the most recent
 * lines — a crash at the bottom of the traceback is what we need to see).
 */
export function formatLogEntries(
  entries: CloudLogEntry[],
  maxBytes: number = 30_000,
): string {
  if (!Array.isArray(entries) || entries.length === 0) return '';

  // Cloud Logging returns newest first; flip to oldest first so traceback
  // reads naturally top-to-bottom.
  const lines = [...entries]
    .reverse()
    .map((e) => {
      const ts = (e.timestamp ?? '').slice(0, 19); // truncate to YYYY-MM-DDTHH:MM:SS
      const sev = e.severity ?? 'INFO';
      // Most container output (Python tracebacks, etc) lands as textPayload.
      // jsonPayload only matters for structured logs from frameworks; render
      // its `message` field if present.
      const text =
        e.textPayload ??
        (e.jsonPayload && typeof e.jsonPayload.message === 'string'
          ? (e.jsonPayload.message as string)
          : '');
      return text ? `[${ts} ${sev}] ${text}` : null;
    })
    .filter((s): s is string => s !== null);

  const joined = lines.join('\n');
  if (joined.length <= maxBytes) return joined;

  // Truncate from the START (keep the LAST maxBytes — crash signals are at
  // the end). Mark the truncation so the LLM knows context was clipped.
  const tail = joined.slice(joined.length - maxBytes);
  // Avoid breaking mid-line at the start.
  const firstNewline = tail.indexOf('\n');
  const cleanTail = firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail;
  return `[... earlier logs truncated to fit ${maxBytes} byte cap ...]\n${cleanTail}`;
}

/**
 * Fetch container logs for a specific Cloud Run revision.
 *
 * Best-effort: on ANY failure (auth, permission denied, network, malformed
 * response), returns null and logs a warning. Never throws — caller is in
 * the failure-handling path and a failed log fetch shouldn't compound the
 * original failure.
 *
 * @param serviceName Cloud Run service name (e.g. `da-wavenet-ai-gateway-backend`)
 * @param revisionName Cloud Run revision name (e.g. `da-...-00003-2x7`)
 * @param gcpProject GCP project ID
 * @param lookbackMs How far back to look. Default 10 minutes covers a typical
 *   container startup + initial crash window.
 * @returns Concatenated log string (formatted via formatLogEntries) or null
 *   on failure / empty.
 */
export async function fetchContainerLogs(
  serviceName: string,
  revisionName: string,
  gcpProject: string,
  lookbackMs: number = 10 * 60 * 1000,
): Promise<string | null> {
  if (!serviceName || !revisionName || !gcpProject) return null;

  // Lazy-load gcp-auth to avoid pulling fetch into pure helpers' import graph.
  let token: string;
  try {
    const { getAccessToken } = await import('./gcp-auth');
    token = await getAccessToken();
  } catch (err) {
    console.warn(`[CloudRunLogs] auth failed: ${(err as Error).message}`);
    return null;
  }

  // Filter: only this service + revision, severity DEFAULT or higher (DEFAULT
  // includes stdout; ERROR/CRITICAL include stderr crashes). Lookback window
  // computed from now.
  const sinceIso = new Date(Date.now() - lookbackMs).toISOString();
  const filter = [
    `resource.type="cloud_run_revision"`,
    `resource.labels.service_name="${serviceName}"`,
    `resource.labels.revision_name="${revisionName}"`,
    `timestamp >= "${sinceIso}"`,
    `severity >= DEFAULT`,
  ].join(' AND ');

  let res: Response;
  try {
    res = await fetch('https://logging.googleapis.com/v2/entries:list', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        resourceNames: [`projects/${gcpProject}`],
        filter,
        orderBy: 'timestamp desc',
        pageSize: 100,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.warn(`[CloudRunLogs] fetch threw: ${(err as Error).message}`);
    return null;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn(
      `[CloudRunLogs] HTTP ${res.status} for service=${serviceName} revision=${revisionName}: ${body.slice(0, 200)}`,
    );
    return null;
  }

  let data: { entries?: CloudLogEntry[] };
  try {
    data = (await res.json()) as { entries?: CloudLogEntry[] };
  } catch (err) {
    console.warn(`[CloudRunLogs] JSON parse failed: ${(err as Error).message}`);
    return null;
  }

  const entries = data.entries ?? [];
  if (entries.length === 0) return null;

  const formatted = formatLogEntries(entries);
  if (!formatted) return null;

  console.log(
    `[CloudRunLogs] fetched ${entries.length} entries for ${serviceName}/${revisionName} (formatted=${formatted.length} bytes)`,
  );
  return formatted;
}
