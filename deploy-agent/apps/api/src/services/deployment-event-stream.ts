/**
 * DeploymentEventStream — per-deployment in-memory pub/sub + ring buffer.
 *
 * Powers the SSE endpoint /api/deploys/:id/stream. Multiple events sources
 * publish here:
 *   - stage transitions (recordStageEvent indirectly, via subscribers)
 *   - build log chunks (build-log-poller pushes via publish)
 *
 * Each published event gets a monotonic `seq` (per-deployment) and is stored
 * in a ring buffer. SSE clients reconnect with `Last-Event-ID: <seq>` and
 * we replay everything > that seq. If the requested seq is older than the
 * oldest in buffer, we emit a `gap` event so the client knows it lost data.
 *
 * Ring size: 2000 events per deployment (typical deploy < 500 events).
 *
 * Memory: buffers stay until manually purged. Caller should `purge(deploymentId)`
 * after the deployment terminates + a grace period (e.g. 10 min via timer).
 *
 * Thread-safety: Node single-threaded so no locks needed.
 */

import { EventEmitter } from 'node:events';

export type DeploymentEventType =
  | 'stage'        // stage transition (extract:started, build:succeeded, ...)
  | 'log'          // build log chunk
  | 'meta'         // deployment-level metadata change (e.g. cloud_run_url updated)
  | 'gap';         // synthetic — server tells client "you missed seq X..Y, request fresh state"

export interface DeploymentEventEnvelope {
  seq: number;                  // monotonic per deployment
  ts: string;                   // ISO timestamp at publish
  type: DeploymentEventType;
  payload: Record<string, unknown>;
}

const RING_SIZE = 2000;
const PURGE_AFTER_MS = 10 * 60 * 1000; // 10 min grace after terminal

interface Streams {
  buffer: DeploymentEventEnvelope[];   // most recent RING_SIZE entries
  nextSeq: number;
  emitter: EventEmitter;               // emits 'event' for each published envelope
  purgeTimer: ReturnType<typeof setTimeout> | null;
  oldestSeq: number;                   // seq of buffer[0] (or nextSeq if empty)
}

const streams = new Map<string, Streams>();

function ensureStream(deploymentId: string): Streams {
  let s = streams.get(deploymentId);
  if (!s) {
    s = {
      buffer: [],
      nextSeq: 1,
      emitter: new EventEmitter(),
      purgeTimer: null,
      oldestSeq: 1,
    };
    s.emitter.setMaxListeners(50);  // many SSE clients possible
    streams.set(deploymentId, s);
  }
  return s;
}

/**
 * Publish a new event into a deployment's stream. Assigns a seq and stores
 * in the ring buffer (evicting oldest if full).
 */
export function publish(
  deploymentId: string,
  type: DeploymentEventType,
  payload: Record<string, unknown>
): DeploymentEventEnvelope {
  const s = ensureStream(deploymentId);
  const envelope: DeploymentEventEnvelope = {
    seq: s.nextSeq++,
    ts: new Date().toISOString(),
    type,
    payload,
  };
  s.buffer.push(envelope);
  if (s.buffer.length > RING_SIZE) {
    s.buffer.shift();
    s.oldestSeq = s.buffer[0].seq;
  } else if (s.buffer.length === 1) {
    s.oldestSeq = envelope.seq;
  }
  s.emitter.emit('event', envelope);
  return envelope;
}

/**
 * Replay all events with seq > `lastSeq` from the ring buffer.
 *
 * Returns:
 *   - { gap: true, evicted_through: N }  when lastSeq is older than oldest in buffer.
 *   - { gap: false, events: [...] }      when caller is in range.
 *
 * Caller should send a `gap` SSE event when gap is true so the client
 * triggers a fresh-state reload (e.g. refetch /timeline).
 */
export function replayFrom(
  deploymentId: string,
  lastSeq: number
): { gap: false; events: DeploymentEventEnvelope[] } | { gap: true; evicted_through: number } {
  const s = streams.get(deploymentId);
  if (!s) return { gap: false, events: [] };
  if (s.buffer.length === 0) return { gap: false, events: [] };
  if (lastSeq < s.oldestSeq - 1) {
    // Client is behind the ring window
    return { gap: true, evicted_through: s.oldestSeq - 1 };
  }
  return { gap: false, events: s.buffer.filter(e => e.seq > lastSeq) };
}

/**
 * Subscribe to live events for a deployment. Returns an unsubscribe fn.
 */
export function subscribe(
  deploymentId: string,
  cb: (envelope: DeploymentEventEnvelope) => void
): () => void {
  const s = ensureStream(deploymentId);
  s.emitter.on('event', cb);
  return () => s.emitter.off('event', cb);
}

/**
 * Schedule a delayed purge of a deployment's buffer. Idempotent — multiple
 * calls reset the timer. Call after a deployment reaches a terminal stage.
 */
export function schedulePurge(deploymentId: string, delayMs: number = PURGE_AFTER_MS): void {
  const s = streams.get(deploymentId);
  if (!s) return;
  if (s.purgeTimer) clearTimeout(s.purgeTimer);
  s.purgeTimer = setTimeout(() => {
    streams.delete(deploymentId);
  }, delayMs);
}

/** Test helper — drop a deployment's stream immediately. */
export function purgeNow(deploymentId: string): void {
  const s = streams.get(deploymentId);
  if (s?.purgeTimer) clearTimeout(s.purgeTimer);
  streams.delete(deploymentId);
}

/** Test helper — inspect current state. */
export function _peek(deploymentId: string): { size: number; nextSeq: number; oldestSeq: number } | null {
  const s = streams.get(deploymentId);
  if (!s) return null;
  return { size: s.buffer.length, nextSeq: s.nextSeq, oldestSeq: s.oldestSeq };
}

/** Constant exposed for tests. */
export const RING_BUFFER_SIZE = RING_SIZE;
