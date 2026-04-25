'use client';

/**
 * DeploymentTimeline — 7-stage horizontal stepper for a single deployment.
 *
 * Reads /api/deploys/:id/timeline. Renders one node per stage in canonical
 * order (extract → build → push → deploy → health_check → ssl) with a
 * status chip (running / succeeded / failed / skipped) and elapsed duration.
 *
 * DS 4.0 tokens: --danger / --warn / --ok / --info / --r-md / --fs-sm.
 */

import { useTranslations } from 'next-intl';

export type StageName =
  | 'upload'
  | 'extract'
  | 'build'
  | 'push'
  | 'deploy'
  | 'health_check'
  | 'ssl';

export type StageStatus = 'started' | 'succeeded' | 'failed' | 'skipped';

export interface StageSummary {
  stage: StageName;
  status: StageStatus;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  metadata: Record<string, unknown>;
}

export interface DeploymentTimelineProps {
  stages: StageSummary[];
  overall: 'pending' | 'running' | 'succeeded' | 'failed';
}

const STAGE_ORDER: StageName[] = [
  'upload', 'extract', 'build', 'push', 'deploy', 'health_check', 'ssl',
];

function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

function statusColor(status: StageStatus): { fg: string; bg: string; border: string } {
  switch (status) {
    case 'succeeded': return { fg: 'var(--ok, #117a3a)', bg: 'var(--ok-bg, #e8f7ee)', border: 'var(--ok, #117a3a)' };
    case 'failed':    return { fg: 'var(--danger, #b42318)', bg: 'var(--danger-bg, #fef3f2)', border: 'var(--danger, #b42318)' };
    case 'started':   return { fg: 'var(--info, #1e6fff)', bg: 'var(--info-bg, #eaf2ff)', border: 'var(--info, #1e6fff)' };
    case 'skipped':   return { fg: 'var(--ink-500, #6b7280)', bg: 'var(--ink-50, #f3f4f6)', border: 'var(--ink-300, #d1d5db)' };
  }
}

export function DeploymentTimeline({ stages, overall }: DeploymentTimelineProps) {
  const t = useTranslations('deploys.detail');
  // Build a stage map for lookup; render in canonical order, hide missing stages.
  const stageMap = new Map<StageName, StageSummary>();
  for (const s of stages) stageMap.set(s.stage, s);

  // The visible stages: only those we have events for (so we don't show
  // empty pending nodes for stages that haven't run).
  const visibleStages = STAGE_ORDER.filter(s => stageMap.has(s));

  if (visibleStages.length === 0) {
    return (
      <div
        role="status"
        style={{
          padding: '20px 16px',
          background: 'var(--ink-50, #f3f4f6)',
          border: '1px solid var(--border, #e5e7eb)',
          borderRadius: 'var(--r-md, 8px)',
          color: 'var(--ink-500, #6b7280)',
          fontSize: 'var(--fs-sm, 14px)',
        }}
      >
        {t('noTimeline')}
      </div>
    );
  }

  return (
    <div
      style={{
        padding: '16px',
        background: 'var(--surface-1, #fff)',
        border: '1px solid var(--border, #e5e7eb)',
        borderRadius: 'var(--r-md, 8px)',
      }}
      data-testid="deployment-timeline"
      data-overall={overall}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${visibleStages.length}, 1fr)`,
          gap: '8px',
        }}
      >
        {visibleStages.map((stage, idx) => {
          const summary = stageMap.get(stage)!;
          const colors = statusColor(summary.status);
          const isLast = idx === visibleStages.length - 1;
          return (
            <div
              key={stage}
              data-stage={stage}
              data-status={summary.status}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: '4px',
                position: 'relative',
              }}
            >
              {/* Connector line to next stage */}
              {!isLast && (
                <div
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    top: '14px',
                    right: '-4px',
                    width: '8px',
                    height: '2px',
                    background: 'var(--ink-200, #e5e7eb)',
                  }}
                />
              )}
              {/* Node */}
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '4px 10px',
                  background: colors.bg,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 'var(--r-pill, 999px)',
                  fontSize: 'var(--fs-xs, 12px)',
                  color: colors.fg,
                  fontWeight: 500,
                }}
              >
                <span aria-hidden="true" style={{
                  display: 'inline-block',
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  background: colors.fg,
                  ...(summary.status === 'started' ? { animation: 'pulse 1.4s ease-in-out infinite' } : {}),
                }} />
                {t(`stage.${stage}`)}
              </div>
              {/* Subtitle: status + duration */}
              <div style={{
                fontSize: 'var(--fs-xs, 12px)',
                color: 'var(--ink-500, #6b7280)',
                marginLeft: '4px',
              }}>
                {t(`status.${summary.status}`)}
                {summary.duration_ms !== null && (
                  <span> · {formatDuration(summary.duration_ms)}</span>
                )}
              </div>
              {/* Failure metadata snippet */}
              {summary.status === 'failed' && summary.metadata && 'error' in summary.metadata && (
                <div
                  style={{
                    marginLeft: '4px',
                    fontSize: 'var(--fs-xs, 12px)',
                    color: 'var(--danger, #b42318)',
                    maxWidth: '100%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={String(summary.metadata.error)}
                >
                  {String(summary.metadata.error).slice(0, 80)}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50%      { opacity: 0.35; }
        }
      `}</style>
    </div>
  );
}
