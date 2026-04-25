# Observability Spike (throwaway code)

Two scripts to validate the kill criteria for Tier 1+2 observability before
investing in Commits 0-3. Both are runnable standalone and emit structured
JSON to stdout. **Do not import from production code.**

Status: scaffolding only — must be run manually with GCP creds (`gcloud auth
application-default login` + `GCP_PROJECT` env var).

---

## Spike A — `spike-sse.ts`: Cloud Run SSE longevity

**Question**: Does Cloud Run hold an SSE stream open for the full 60 min request
ceiling without dropping ticks, when CPU-throttling is on (default)?

**Kill criterion**: If we cannot keep an SSE alive for ≥ 30 min when
CPU-throttling is on, OR if the cost of `--no-cpu-throttling` exceeds
**$0.005 per active stream-minute** at our typical concurrency (≤ 5 streams),
we abandon SSE and fall back to short polling (5 s, same `/timeline` endpoint
client-side).

**How**:
1. Deploy this server with default Cloud Run settings (CPU throttled).
2. From a laptop, `curl -N <url>/sse` and let it run for 60 min.
3. Record any gaps > 5 s in tick sequence.
4. Redeploy with `--no-cpu-throttling --cpu-boost`. Repeat. Compare cost.

**Run locally**:
```bash
cd apps/api && tsx src/spike/spike-sse.ts
# in another terminal:
curl -N http://localhost:7771/sse
```

---

## Spike B — `spike-buildlog.ts`: GCS Cloud Build log polling latency

**Question**: How fresh is `gs://{project_num}_cloudbuild/log-{build_id}.txt`?
Can we deliver chunks to the user within < 1 s of Cloud Build emitting them?

**Kill criterion**: If the GCS object is stale by more than **3 s p95** (i.e.,
chunks land in the file > 3 s after Cloud Build CLI shows them), we cannot
claim "live log streaming" and must change the wedge story (truncate to
post-mortem-only or use a private alpha API).

**How**:
1. Trigger a real Cloud Build job (any project: `gcloud builds submit ...`).
2. While it's running, run this spike with `BUILD_ID=<id>` and `PROJECT_NUM=<num>`.
3. Compare the script's stdout timeline vs `gcloud builds log $BUILD_ID --stream`.
4. Compute p50/p95 of the lag.

**Run locally**:
```bash
cd apps/api && BUILD_ID=abc123 PROJECT_NUM=765716329849 \
  tsx src/spike/spike-buildlog.ts
```

---

## Why throwaway

Neither file is wired into the API server. After Phase 1 spike validation, the
proven patterns get refactored into:
- `apps/api/src/routes/deploys.ts` (real `/api/deploys/:id/stream` SSE)
- `apps/api/src/services/build-log-poller.ts` (real GCS poller with EventEmitter)

Then this directory gets deleted in the same commit that adds the real services.
