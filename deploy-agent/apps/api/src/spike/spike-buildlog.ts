/**
 * Spike B: GCS Cloud Build log polling latency test (THROWAWAY).
 *
 * Polls the per-build GCS log object every 1.5 s and reports newly-appended
 * bytes with timestamps. Compare the printed timeline vs `gcloud builds log
 * $BUILD_ID --stream` to compute lag. See README.md for kill criteria.
 *
 * Run:
 *   gcloud auth application-default login
 *   BUILD_ID=abc123 PROJECT_NUM=765716329849 tsx src/spike/spike-buildlog.ts
 */

const BUILD_ID = process.env.BUILD_ID;
const PROJECT_NUM = process.env.PROJECT_NUM;
const POLL_MS = Number(process.env.POLL_MS ?? 1500);

if (!BUILD_ID || !PROJECT_NUM) {
  console.error('Set BUILD_ID and PROJECT_NUM env vars');
  process.exit(1);
}

const BUCKET = `${PROJECT_NUM}_cloudbuild`;
const OBJECT = `log-${BUILD_ID}.txt`;

async function getAccessToken(): Promise<string> {
  // Try ADC via gcloud
  const { execSync } = await import('node:child_process');
  try {
    const tok = execSync('gcloud auth application-default print-access-token', { encoding: 'utf-8' }).trim();
    return tok;
  } catch (e) {
    throw new Error(`No ADC token. Run: gcloud auth application-default login. ${(e as Error).message}`);
  }
}

interface ObjectMeta {
  size: number;
  generation: string;
  updated: string;
  exists: boolean;
}

async function statObject(token: string): Promise<ObjectMeta> {
  const url = `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(OBJECT)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return { size: 0, generation: '0', updated: '', exists: false };
  if (!r.ok) throw new Error(`stat failed: ${r.status} ${await r.text()}`);
  const j = await r.json() as { size: string; generation: string; updated: string };
  return { size: Number(j.size), generation: j.generation, updated: j.updated, exists: true };
}

async function fetchRange(token: string, start: number): Promise<{ bytes: string; status: number }> {
  const url = `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(OBJECT)}?alt=media`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Range: `bytes=${start}-`,
    },
  });
  if (r.status === 416) return { bytes: '', status: 416 }; // range not satisfiable (no new bytes)
  if (!r.ok && r.status !== 206) throw new Error(`range fetch failed: ${r.status} ${await r.text()}`);
  return { bytes: await r.text(), status: r.status };
}

async function main() {
  const token = await getAccessToken();
  let offset = 0;
  let lastSize = 0;
  const start = Date.now();

  console.log(JSON.stringify({ event: 'spike_start', bucket: BUCKET, object: OBJECT, poll_ms: POLL_MS }));

  while (true) {
    const tickStart = Date.now();
    let meta: ObjectMeta;
    try {
      meta = await statObject(token);
    } catch (e) {
      console.log(JSON.stringify({ event: 'stat_error', error: (e as Error).message }));
      await new Promise(r => setTimeout(r, POLL_MS));
      continue;
    }

    if (!meta.exists) {
      console.log(JSON.stringify({ event: 'object_missing', t_ms: Date.now() - start }));
    } else if (meta.size > lastSize) {
      const fetched = await fetchRange(token, offset);
      const newBytes = fetched.bytes;
      const lines = newBytes.split('\n').filter(l => l.length > 0);
      const lagMs = Date.now() - new Date(meta.updated).getTime();
      console.log(JSON.stringify({
        event: 'new_chunk',
        elapsed_ms: Date.now() - start,
        size_before: lastSize,
        size_after: meta.size,
        delta_bytes: meta.size - lastSize,
        lines: lines.length,
        gcs_updated: meta.updated,
        observed_lag_ms: lagMs,
        sample_first_line: lines[0]?.slice(0, 120),
        sample_last_line: lines[lines.length - 1]?.slice(0, 120),
      }));
      offset = meta.size;
      lastSize = meta.size;
    } else {
      console.log(JSON.stringify({ event: 'no_change', size: lastSize, t_ms: Date.now() - start }));
    }

    const used = Date.now() - tickStart;
    const wait = Math.max(0, POLL_MS - used);
    await new Promise(r => setTimeout(r, wait));
  }
}

main().catch(e => {
  console.error(JSON.stringify({ event: 'fatal', error: (e as Error).message }));
  process.exit(1);
});
