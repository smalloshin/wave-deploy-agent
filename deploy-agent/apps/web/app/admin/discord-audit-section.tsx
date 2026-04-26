'use client';

/**
 * Discord NL audit-trail tab — admin dashboard.
 *
 * Mirrors AuditLogSection (in admin/page.tsx) for visual consistency:
 *   - filter pills across the top (status + reset)
 *   - table of rows ordered by created_at DESC
 *   - prev/next pagination at the bottom
 *
 * No own permission check — parent (admin/page.tsx) gates tab visibility on
 * canManageUsers, so by the time this component mounts the user already has
 * users:manage. The API still enforces it independently.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const PAGE_SIZE = 50;

type DiscordAuditStatus =
  | 'pending'
  | 'success'
  | 'error'
  | 'denied'
  | 'cancelled';

interface DiscordAuditEntry {
  id: number;
  discord_user_id: string;
  channel_id: string;
  message_id: string | null;
  tool_name: string;
  tool_input: Record<string, unknown>;
  intent_text: string | null;
  status: DiscordAuditStatus;
  result_text: string | null;
  llm_provider: string | null;
  created_at: string;
  updated_at: string;
}

interface ListResponse {
  entries: DiscordAuditEntry[];
  total: number;
  limit: number;
  offset: number;
}

const STATUS_FILTERS: Array<DiscordAuditStatus | 'all'> = [
  'all',
  'pending',
  'success',
  'error',
  'denied',
  'cancelled',
];

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { credentials: 'include' });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `${path}: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export default function DiscordAuditSection() {
  const t = useTranslations('admin.discordAudit');
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<DiscordAuditStatus | 'all'>(
    'all',
  );
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<DiscordAuditEntry | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(offset));
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const result = await apiGet<ListResponse>(
        `/api/discord-audit?${params.toString()}`,
      );
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, offset]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function handleStatusChange(s: DiscordAuditStatus | 'all') {
    setStatusFilter(s);
    setOffset(0);
  }

  if (error) {
    return (
      <div style={{ color: 'var(--status-critical)', fontSize: 'var(--fs-md)' }}>
        {error}
      </div>
    );
  }
  if (!data && !loading) {
    return (
      <div style={{ color: 'var(--ink-500)', fontSize: 'var(--fs-md)' }}>
        Loading...
      </div>
    );
  }

  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);

  return (
    <div>
      {/* Filter pills */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          marginBottom: 16,
          alignItems: 'center',
        }}
      >
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            onClick={() => handleStatusChange(s)}
            style={statusFilter === s ? btnPrimary : btnGhost}
          >
            {s === 'all' ? t('all') : t(`status.${s}`)}
          </button>
        ))}
        <button onClick={refresh} style={btnGhost} disabled={loading}>
          {loading ? t('loading') : t('refresh')}
        </button>
        <span
          style={{
            color: 'var(--ink-500)',
            fontSize: 'var(--fs-sm)',
            marginLeft: 'auto',
          }}
        >
          {t('counter', { start: pageStart, end: pageEnd, total })}
        </span>
      </div>

      {/* Table */}
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={th}>{t('time')}</th>
            <th style={th}>{t('user')}</th>
            <th style={th}>{t('tool')}</th>
            <th style={th}>{t('status.label')}</th>
            <th style={th}>{t('intent')}</th>
            <th style={th}>{t('result')}</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 && (
            <tr>
              <td
                colSpan={6}
                style={{
                  ...td,
                  textAlign: 'center',
                  color: 'var(--ink-500)',
                  padding: 'var(--sp-5)',
                }}
              >
                {t('empty')}
              </td>
            </tr>
          )}
          {entries.map((e) => (
            <tr
              key={e.id}
              onClick={() => setSelected(e)}
              style={{
                borderTop: '1px solid var(--border)',
                cursor: 'pointer',
              }}
            >
              <td style={{ ...td, fontSize: 12, whiteSpace: 'nowrap' }}>
                {new Date(e.created_at).toLocaleString()}
              </td>
              <td
                style={{
                  ...td,
                  fontSize: 12,
                  fontFamily: 'var(--font-mono, monospace)',
                }}
              >
                {e.discord_user_id}
              </td>
              <td
                style={{
                  ...td,
                  fontSize: 12,
                  fontFamily: 'var(--font-mono, monospace)',
                }}
              >
                {e.tool_name}
              </td>
              <td style={{ ...td, fontSize: 12 }}>
                <StatusPill status={e.status} label={t(`status.${e.status}`)} />
              </td>
              <td
                style={{
                  ...td,
                  fontSize: 12,
                  maxWidth: 260,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: 'var(--ink-700)',
                }}
                title={e.intent_text ?? ''}
              >
                {e.intent_text ?? '—'}
              </td>
              <td
                style={{
                  ...td,
                  fontSize: 12,
                  maxWidth: 260,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: 'var(--ink-500)',
                }}
                title={e.result_text ?? ''}
              >
                {e.result_text ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Pagination */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: 8,
          marginTop: 16,
        }}
      >
        <button
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          disabled={!hasPrev || loading}
          style={hasPrev ? btnGhost : { ...btnGhost, opacity: 0.4, cursor: 'not-allowed' }}
        >
          {t('prev')}
        </button>
        <button
          onClick={() => setOffset(offset + PAGE_SIZE)}
          disabled={!hasNext || loading}
          style={hasNext ? btnGhost : { ...btnGhost, opacity: 0.4, cursor: 'not-allowed' }}
        >
          {t('next')}
        </button>
      </div>

      {selected && (
        <DetailModal entry={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function StatusPill({
  status,
  label,
}: {
  status: DiscordAuditStatus;
  label: string;
}) {
  // Match the auth audit color scheme where applicable:
  //   success → success-bg, error/denied → critical/warning-bg
  //   pending → ink-50 (gray), cancelled → ink-50 italic
  const bg =
    status === 'success'
      ? 'var(--status-success-bg)'
      : status === 'error'
        ? 'var(--status-critical-bg)'
        : status === 'denied'
          ? 'var(--status-warning-bg)'
          : 'var(--ink-50)';
  const color =
    status === 'success'
      ? 'var(--status-success)'
      : status === 'error'
        ? 'var(--status-critical)'
        : status === 'denied'
          ? 'var(--status-warning)'
          : 'var(--ink-500)';
  return (
    <span
      style={{
        ...pillStyle,
        background: bg,
        color,
        fontStyle: status === 'cancelled' ? 'italic' : 'normal',
      }}
    >
      {label}
    </span>
  );
}

function DetailModal({
  entry,
  onClose,
}: {
  entry: DiscordAuditEntry;
  onClose: () => void;
}) {
  const t = useTranslations('admin.discordAudit');
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(11,14,20,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          padding: 'var(--sp-5)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-lg)',
          background: 'var(--surface-raised)',
          width: 640,
          maxHeight: '80vh',
          overflowY: 'auto',
        }}
      >
        <h3
          style={{
            margin: '0 0 var(--sp-4) 0',
            fontSize: 'var(--fs-lg)',
            color: 'var(--ink-900)',
          }}
        >
          {t('detailTitle', { id: entry.id })}
        </h3>

        <DetailField label={t('time')} value={new Date(entry.created_at).toLocaleString()} />
        <DetailField label={t('user')} value={entry.discord_user_id} mono />
        <DetailField label={t('channel')} value={entry.channel_id} mono />
        <DetailField label={t('tool')} value={entry.tool_name} mono />
        <DetailField label={t('status.label')} value={t(`status.${entry.status}`)} />
        {entry.llm_provider && (
          <DetailField label={t('llmProvider')} value={entry.llm_provider} />
        )}
        {entry.intent_text && (
          <DetailField label={t('intent')} value={entry.intent_text} />
        )}
        {entry.result_text && (
          <DetailField label={t('result')} value={entry.result_text} />
        )}
        <div style={{ marginTop: 'var(--sp-3)' }}>
          <div
            style={{
              fontSize: 'var(--fs-sm)',
              color: 'var(--ink-500)',
              marginBottom: 4,
            }}
          >
            {t('toolInput')}
          </div>
          <pre
            style={{
              padding: 'var(--sp-3)',
              background: 'var(--ink-50)',
              borderRadius: 'var(--r-sm)',
              fontSize: 12,
              overflow: 'auto',
              maxHeight: 200,
              margin: 0,
            }}
          >
            {JSON.stringify(entry.tool_input, null, 2)}
          </pre>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            marginTop: 'var(--sp-5)',
          }}
        >
          <button onClick={onClose} style={btnPrimary}>
            {t('close')}
          </button>
        </div>
      </div>
    </div>
  );
}

function DetailField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div style={{ marginBottom: 'var(--sp-3)' }}>
      <div
        style={{
          fontSize: 'var(--fs-sm)',
          color: 'var(--ink-500)',
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 'var(--fs-md)',
          color: 'var(--ink-900)',
          fontFamily: mono ? 'var(--font-mono, monospace)' : 'inherit',
          wordBreak: 'break-word',
        }}
      >
        {value}
      </div>
    </div>
  );
}

// ─── Shared styles (mirror admin/page.tsx) ───────────────────

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 'var(--fs-sm)',
  background: 'var(--surface-1)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-lg)',
  overflow: 'hidden',
};
const th: React.CSSProperties = {
  textAlign: 'left',
  padding: 'var(--sp-3) var(--sp-4)',
  fontWeight: 600,
  color: 'var(--ink-500)',
  fontSize: 'var(--fs-sm)',
  borderBottom: '1px solid var(--border)',
  background: 'var(--ink-50)',
};
const td: React.CSSProperties = {
  padding: 'var(--sp-3) var(--sp-4)',
  verticalAlign: 'middle',
  borderBottom: '1px solid var(--ink-100)',
  color: 'var(--ink-700)',
  fontSize: 'var(--fs-sm)',
};
const btnPrimary: React.CSSProperties = {
  padding: '8px var(--sp-4)',
  background: 'var(--sea-500)',
  color: 'var(--text-inverse)',
  border: '1px solid var(--sea-500)',
  borderRadius: 'var(--r-md)',
  fontSize: 'var(--fs-sm)',
  cursor: 'pointer',
  fontWeight: 600,
  fontFamily: 'inherit',
};
const btnGhost: React.CSSProperties = {
  padding: '8px var(--sp-4)',
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-md)',
  fontSize: 'var(--fs-sm)',
  cursor: 'pointer',
  color: 'var(--ink-700)',
  fontFamily: 'inherit',
  fontWeight: 500,
};
const pillStyle: React.CSSProperties = {
  padding: '2px var(--sp-2)',
  background: 'var(--sea-50)',
  borderRadius: 'var(--r-sm)',
  fontSize: 'var(--fs-xs)',
  fontFamily: 'var(--font-mono, monospace)',
  color: 'var(--sea-700)',
  fontWeight: 500,
};
