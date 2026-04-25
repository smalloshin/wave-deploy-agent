'use client';

/**
 * Deployment detail page — Tier 1 (Timeline) lives here.
 *
 * Future tiers wire in below the timeline:
 *   - Tier 2 (LogStream): SSE consumer of /api/deploys/:id/stream
 *   - Tier 3 (DiagnosticBlock): on-demand /api/deploys/:id/diagnose
 *
 * Polls the timeline endpoint every 5 s while overall === 'running' so the
 * user sees stages tick over without manual refresh. Stops polling when the
 * deploy reaches a terminal state.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useParams } from 'next/navigation';
import { DeploymentTimeline, type StageSummary } from '../../components/DeploymentTimeline';
import { LogStream } from '../../components/LogStream';
import { DiagnosticBlock } from '../../components/DiagnosticBlock';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

interface TimelineResponse {
  deployment: {
    id: string;
    project_id: string;
    version: number;
    cloud_run_url: string | null;
    custom_domain: string | null;
    health_status: string | null;
    ssl_status: string | null;
    created_at: string;
    deployed_at: string | null;
  };
  overall: 'pending' | 'running' | 'succeeded' | 'failed';
  stages: StageSummary[];
  events: Array<{
    id: number;
    deployment_id: string;
    stage: string;
    status: string;
    metadata: Record<string, unknown>;
    created_at: string;
  }>;
}

export default function DeployDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const t = useTranslations('deploys.detail');

  const [data, setData] = useState<TimelineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      try {
        const r = await fetch(`${API}/api/deploys/${id}/timeline`, { credentials: 'include' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as TimelineResponse;
        if (cancelled) return;
        setData(j);
        setError(null);
        setLoading(false);
        // Continue polling while running; stop once terminal.
        if (j.overall === 'running' || j.overall === 'pending') {
          timer = setTimeout(load, 5000);
        }
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
        setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  if (loading) {
    return (
      <div style={{ padding: 'var(--sp-5)', color: 'var(--ink-500)' }}>{t('loading')}</div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: 'var(--sp-5)', color: 'var(--danger)' }}>
        {t('loadError', { error })}
      </div>
    );
  }
  if (!data) return null;

  const { deployment, overall, stages } = data;
  const overallColors: Record<typeof overall, { fg: string; bg: string }> = {
    pending:   { fg: 'var(--ink-500)', bg: 'var(--ink-50)' },
    running:   { fg: 'var(--info)',    bg: 'var(--info-bg)' },
    succeeded: { fg: 'var(--ok)',      bg: 'var(--ok-bg, #e8f7ee)' },
    failed:    { fg: 'var(--danger)',  bg: 'var(--danger-bg)' },
  };
  const oc = overallColors[overall];

  return (
    <div data-testid="deploy-detail-page">
      <a
        href="/deploys"
        style={{
          display: 'inline-block',
          marginBottom: 'var(--sp-3)',
          fontSize: 'var(--fs-sm)',
          color: 'var(--ink-500)',
          textDecoration: 'none',
        }}
      >
        {t('back')}
      </a>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: 'var(--sp-4)' }}>
        <h2 style={{
          fontSize: 'var(--fs-2xl)',
          fontWeight: 700,
          letterSpacing: '-0.02em',
          lineHeight: 'var(--lh-tight)',
          color: 'var(--ink-900)',
          margin: 0,
        }}>
          {t('title', { version: deployment.version })}
        </h2>
        <span
          data-testid="overall-status"
          style={{
            padding: '4px 12px',
            background: oc.bg,
            color: oc.fg,
            border: `1px solid ${oc.fg}`,
            borderRadius: 'var(--r-pill)',
            fontSize: 'var(--fs-sm)',
            fontWeight: 500,
          }}
        >
          {t(`overall.${overall}`)}
        </span>
        {deployment.cloud_run_url && (
          <a
            href={deployment.cloud_run_url}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="open-service-link"
            style={{
              fontSize: 'var(--fs-sm)',
              color: 'var(--sea-500, #1e6fff)',
              textDecoration: 'none',
            }}
          >
            {t('openService')}
          </a>
        )}
      </div>

      <DeploymentTimeline stages={stages} overall={overall} />

      <LogStream
        deploymentId={deployment.id}
        terminal={overall === 'succeeded' || overall === 'failed'}
        // On gap, the SSE server says we fell behind the ring buffer. Refetch
        // the timeline immediately to get fresh state instead of stale cache.
        onGap={() => {
          setLoading(true);
          // The polling effect will pick up via re-render; explicit fetch below
          // for immediate refresh.
          fetch(`${API}/api/deploys/${id}/timeline`, { credentials: 'include' })
            .then(r => r.json() as Promise<TimelineResponse>)
            .then(j => { setData(j); setLoading(false); })
            .catch(() => setLoading(false));
        }}
      />

      {overall === 'failed' && (
        <DiagnosticBlock deploymentId={deployment.id} kind="failure" />
      )}
    </div>
  );
}
