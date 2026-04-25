/**
 * Spike A: Cloud Run SSE longevity test (THROWAWAY).
 *
 * Verifies SSE stream survives Cloud Run's 60 min request ceiling. See README.md
 * for kill criteria. Do NOT import this from production.
 *
 * Run: `tsx src/spike/spike-sse.ts` then `curl -N http://localhost:7771/sse`
 */

import Fastify from 'fastify';

const PORT = Number(process.env.SPIKE_PORT ?? 7771);
const TICK_MS = 1000;

const app = Fastify({ logger: false });

app.get('/sse', async (req, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let seq = 0;
  const start = Date.now();
  const send = (event: string, data: unknown) => {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send('hello', { t: new Date().toISOString(), pid: process.pid });

  const ticker = setInterval(() => {
    seq += 1;
    send('tick', {
      seq,
      elapsed_ms: Date.now() - start,
      t: new Date().toISOString(),
    });
  }, TICK_MS);

  // Keepalive comments (15 s) — defeats some intermediary buffering.
  const keepalive = setInterval(() => {
    reply.raw.write(`: keepalive ${Date.now()}\n\n`);
  }, 15_000);

  req.raw.on('close', () => {
    clearInterval(ticker);
    clearInterval(keepalive);
    console.log(JSON.stringify({
      event: 'client_close',
      seq_final: seq,
      duration_ms: Date.now() - start,
    }));
  });
});

app.get('/healthz', async () => ({ ok: true }));

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  console.log(JSON.stringify({
    event: 'listening',
    port: PORT,
    note: 'curl -N http://localhost:' + PORT + '/sse',
  }));
});
