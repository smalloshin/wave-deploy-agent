'use client';

/**
 * LogStream — Tier 2 of the deployment observability stack.
 *
 * Two parts:
 *   1. Live SSE feed (/api/deploys/:id/stream) — shows stage transitions AND
 *      live build-log chunks as they happen. Reconnects with Last-Event-ID.
 *      Handles `gap` event by refetching the timeline (signaling parent via onGap).
 *      Live build-log streaming was added 2026-04-26 via the `onBuildStarted`
 *      hook in deploy-engine; chunks land as `log` events with payload.text and
 *      bookend `meta` events (build_log_stream_started/error/ended).
 *   2. Build log block — once terminal, optionally lazy-load the FULL GCS log
 *      via /api/deploys/:id/build-log. Useful when the ring buffer evicted early
 *      chunks or the user joined mid-build.
 *
 * DS 4.0 tokens only. No external deps.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type StreamEventType = 'stage' | 'log' | 'meta' | 'gap';

interface StreamEvent {
  seq: number;
  ts: string;
  type: StreamEventType;
  payload: Record<string, unknown>;
}

interface LogStreamProps {
  deploymentId: string;
  /** Called when the server signals that the client fell behind the ring buffer. */
  onGap?: () => void;
  /** True when the deploy has finished (terminal); component stops streaming and shows static log. */
  terminal: boolean;
}

export function LogStream({ deploymentId, onGap, terminal }: LogStreamProps) {
  const t = useTranslations('deploys.detail');
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [buildLog, setBuildLog] = useState<string | null>(null);
  const [buildLogError, setBuildLogError] = useState<string | null>(null);
  const [buildLogLoading, setBuildLogLoading] = useState(false);
  const lastSeqRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);

  // SSE subscription — runs while not terminal. Reconnects with Last-Event-ID.
  useEffect(() => {
    if (!deploymentId) return;
    if (terminal) {
      // Close any existing connection once terminal — no more events expected.
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      setConnected(false);
      return;
    }

    let stopped = false;

    const connect = () => {
      if (stopped) return;
      // Note: native EventSource doesn't allow setting Last-Event-ID header on
      // the initial connection. We pass it as a query param and the route
      // accepts both forms. Browsers DO automatically resend the last seen id
      // on auto-reconnect, but we want explicit control across remounts.
      const url = `${API}/api/deploys/${deploymentId}/stream`;
      const es = new EventSource(url, { withCredentials: true });
      esRef.current = es;

      es.addEventListener('open', () => {
        if (stopped) return;
        setConnected(true);
        setStreamError(null);
      });

      const handle = (type: StreamEventType) => (e: MessageEvent) => {
        if (stopped) return;
        try {
          const data = JSON.parse(e.data) as Record<string, unknown>;
          const seq = e.lastEventId ? Number(e.lastEventId) : lastSeqRef.current + 1;
          lastSeqRef.current = seq;
          const env: StreamEvent = {
            seq,
            ts: (data.ts as string) ?? new Date().toISOString(),
            type,
            payload: data,
          };
          if (type === 'gap') {
            onGap?.();
            return;
          }
          setEvents(prev => {
            // Dedup by seq in case of double-delivery
            if (prev.some(p => p.seq === env.seq)) return prev;
            return [...prev, env].slice(-500); // cap UI list
          });
        } catch {
          /* malformed event, ignore */
        }
      };

      es.addEventListener('stage', handle('stage'));
      es.addEventListener('log', handle('log'));
      es.addEventListener('meta', handle('meta'));
      es.addEventListener('gap', handle('gap'));

      es.addEventListener('error', () => {
        if (stopped) return;
        setConnected(false);
        setStreamError('connection lost — retrying');
        // EventSource auto-reconnects, but if it's stuck closed we force a reconnect.
        if (es.readyState === EventSource.CLOSED) {
          es.close();
          esRef.current = null;
          setTimeout(connect, 2000);
        }
      });
    };

    connect();
    return () => {
      stopped = true;
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [deploymentId, terminal, onGap]);

  // Lazy-load build log when terminal and not yet fetched.
  // (We trigger it only when the user opens the panel — see button below.)
  const fetchBuildLog = async () => {
    if (buildLog || buildLogLoading) return;
    setBuildLogLoading(true);
    setBuildLogError(null);
    try {
      const r = await fetch(`${API}/api/deploys/${deploymentId}/build-log`, { credentials: 'include' });
      const j = await r.json() as { text?: string; error?: string };
      if (!r.ok) {
        setBuildLogError(j.error ?? `HTTP ${r.status}`);
      } else {
        setBuildLog(j.text ?? '');
      }
    } catch (e) {
      setBuildLogError((e as Error).message);
    } finally {
      setBuildLogLoading(false);
    }
  };

  return (
    <div data-testid="log-stream" style={{ marginTop: 'var(--sp-5)' }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        marginBottom: 'var(--sp-3)',
      }}>
        <h3 style={{
          fontSize: 'var(--fs-lg)',
          fontWeight: 600,
          color: 'var(--ink-900)',
          margin: 0,
        }}>
          {t('logStream.title')}
        </h3>
        {!terminal && (
          <span
            data-testid="stream-status"
            style={{
              padding: '2px 10px',
              fontSize: 'var(--fs-xs)',
              borderRadius: 'var(--r-pill)',
              background: connected ? 'var(--ok-bg, #e8f7ee)' : 'var(--ink-50)',
              color: connected ? 'var(--ok)' : 'var(--ink-500)',
              border: `1px solid ${connected ? 'var(--ok)' : 'var(--ink-200, #e3e6eb)'}`,
            }}
          >
            {connected ? t('logStream.live') : t('logStream.connecting')}
          </span>
        )}
        {streamError && (
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--danger)' }}>{streamError}</span>
        )}
      </div>

      {/* Event list — most recent at bottom */}
      <div
        data-testid="event-list"
        style={{
          background: 'var(--ink-50)',
          border: '1px solid var(--ink-200, #e3e6eb)',
          borderRadius: 'var(--r-md)',
          padding: 'var(--sp-3)',
          fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
          fontSize: 'var(--fs-sm)',
          maxHeight: '320px',
          overflowY: 'auto',
          color: 'var(--ink-700)',
        }}
      >
        {events.length === 0 ? (
          <div style={{ color: 'var(--ink-500)', fontStyle: 'italic' }}>
            {terminal ? t('logStream.empty') : t('logStream.waiting')}
          </div>
        ) : (
          events.map((e) => (
            <div
              key={e.seq}
              data-event-type={e.type}
              data-event-seq={e.seq}
              style={{ padding: '2px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
            >
              <span style={{ color: 'var(--ink-500)' }}>{formatTs(e.ts)}</span>
              {' '}
              <span style={{
                color: e.type === 'stage' ? 'var(--info)' : 'var(--ink-700)',
                fontWeight: e.type === 'stage' ? 500 : 400,
              }}>
                [{e.type}]
              </span>
              {' '}
              {renderPayload(e)}
            </div>
          ))
        )}
      </div>

      {/* Build log block — only meaningful once build is terminal */}
      {terminal && (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          {buildLog === null ? (
            <button
              type="button"
              onClick={fetchBuildLog}
              disabled={buildLogLoading}
              data-testid="load-build-log"
              style={{
                padding: '6px 14px',
                fontSize: 'var(--fs-sm)',
                background: 'var(--ink-50)',
                color: 'var(--ink-700)',
                border: '1px solid var(--ink-200, #e3e6eb)',
                borderRadius: 'var(--r-md)',
                cursor: buildLogLoading ? 'wait' : 'pointer',
              }}
            >
              {buildLogLoading ? t('logStream.loadingBuildLog') : t('logStream.loadBuildLog')}
            </button>
          ) : (
            <pre
              data-testid="build-log"
              style={{
                marginTop: 'var(--sp-2)',
                background: 'var(--ink-900)',
                color: 'var(--ink-50)',
                padding: 'var(--sp-3)',
                borderRadius: 'var(--r-md)',
                fontSize: 'var(--fs-xs)',
                fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
                maxHeight: '400px',
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {buildLog.length === 0 ? t('logStream.emptyBuildLog') : buildLog}
            </pre>
          )}
          {buildLogError && (
            <div style={{
              marginTop: 'var(--sp-2)',
              fontSize: 'var(--fs-sm)',
              color: 'var(--danger)',
            }}>
              {buildLogError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatTs(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toISOString().slice(11, 19);  // HH:mm:ss
  } catch {
    return iso;
  }
}

function renderPayload(e: StreamEvent): string {
  if (e.type === 'stage') {
    const stage = e.payload.stage as string | undefined;
    const status = e.payload.status as string | undefined;
    return `${stage}:${status}`;
  }
  if (e.type === 'log') {
    // Live build-log chunk shape (since 2026-04-26):
    //   { build_id, bytes_offset, text, lag_ms, gcs_updated }
    // We also accept a `line` field defensively in case other code paths emit
    // log events with that shape; current backend only emits `text`.
    const text =
      (e.payload.text as string | undefined) ??
      (e.payload.line as string | undefined);
    if (text != null) {
      // Strip a single trailing newline; we render one event per line already.
      return text.replace(/\n$/, '');
    }
    return JSON.stringify(e.payload);
  }
  if (e.type === 'meta') {
    const kind = e.payload.kind as string | undefined;
    const buildId = e.payload.build_id as string | undefined;
    const shortId = buildId ? buildId.slice(0, 8) : '';
    switch (kind) {
      case 'build_log_stream_started':
        return shortId ? `build log stream started (${shortId})` : 'build log stream started';
      case 'build_log_stream_ended':
        return 'build log stream ended';
      case 'build_log_stream_error': {
        const err = (e.payload.error as string | undefined) ?? 'unknown';
        return `build log stream error: ${err}`;
      }
      default:
        return JSON.stringify(e.payload);
    }
  }
  return JSON.stringify(e.payload);
}
