'use client';

/**
 * DiagnosticBlock — Tier 3 of deployment observability.
 *
 * On a failed deployment, the user clicks "Explain why this failed" to
 * trigger /api/deploys/:id/diagnose (POST). The result is cached server-side
 * by build_id (for build failures) or deployment_id (for everything else),
 * so subsequent loads are free and instant.
 *
 * GET /diagnose returns 404 when no cached diagnosis exists. We attempt a GET
 * on mount to surface a previously generated diagnosis without re-billing the
 * LLM; the explicit POST button is the only path that costs money.
 *
 * DS 4.0 tokens only.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

interface Suggestion {
  title: string;
  body: string;
}

interface Diagnosis {
  cache_key: string;
  kind: 'failure' | 'slow';
  summary: string;
  root_cause: string | null;
  suggestions: Suggestion[];
  log_excerpt?: string | null;
  model: string | null;
  created_at: string;
}

interface DiagnoseResponse {
  cached: boolean;
  diagnosis: Diagnosis;
}

interface DiagnosticBlockProps {
  deploymentId: string;
  /** 'failure' (default) or 'slow' */
  kind?: 'failure' | 'slow';
}

export function DiagnosticBlock({ deploymentId, kind = 'failure' }: DiagnosticBlockProps) {
  const t = useTranslations('deploys.detail.diagnostic');
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cached, setCached] = useState(false);
  const [checkedCache, setCheckedCache] = useState(false);

  // On mount, try GET — surfaces a previously generated diagnosis for free.
  useEffect(() => {
    let stopped = false;
    (async () => {
      try {
        const r = await fetch(
          `${API}/api/deploys/${deploymentId}/diagnose?kind=${kind}`,
          { credentials: 'include' }
        );
        if (stopped) return;
        if (r.ok) {
          const j = await r.json() as DiagnoseResponse;
          setDiagnosis(j.diagnosis);
          setCached(true);
        }
        // 404 is the expected "no cache yet" case — fall through silently
      } catch {
        // Network error checking cache — user can still click to generate
      } finally {
        if (!stopped) setCheckedCache(true);
      }
    })();
    return () => { stopped = true; };
  }, [deploymentId, kind]);

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${API}/api/deploys/${deploymentId}/diagnose`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
      });
      const j = await r.json() as DiagnoseResponse | { error: string };
      if (!r.ok) {
        setError(('error' in j ? j.error : null) ?? `HTTP ${r.status}`);
        return;
      }
      const d = (j as DiagnoseResponse).diagnosis;
      setDiagnosis(d);
      setCached((j as DiagnoseResponse).cached);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // Don't render anything until we've checked the cache (avoids flicker).
  if (!checkedCache) return null;

  return (
    <div data-testid="diagnostic-block" style={{
      marginTop: 'var(--sp-5)',
      padding: 'var(--sp-4)',
      background: kind === 'failure' ? 'var(--danger-bg)' : 'var(--warn-bg, #fff8e6)',
      border: `1px solid ${kind === 'failure' ? 'var(--danger)' : 'var(--warn, #d97706)'}`,
      borderRadius: 'var(--r-md)',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        marginBottom: diagnosis ? 'var(--sp-3)' : 0,
      }}>
        <h3 style={{
          fontSize: 'var(--fs-lg)',
          fontWeight: 600,
          color: kind === 'failure' ? 'var(--danger)' : 'var(--ink-900)',
          margin: 0,
        }}>
          {t(`title.${kind}`)}
        </h3>
        {cached && diagnosis && (
          <span style={{
            fontSize: 'var(--fs-xs)',
            color: 'var(--ink-500)',
          }}>
            {t('cached')}
          </span>
        )}
      </div>

      {!diagnosis && (
        <div>
          <p style={{
            margin: '0 0 var(--sp-3) 0',
            fontSize: 'var(--fs-sm)',
            color: 'var(--ink-700)',
          }}>
            {t(`prompt.${kind}`)}
          </p>
          <button
            type="button"
            onClick={generate}
            disabled={loading}
            data-testid="diagnose-button"
            style={{
              padding: '8px 18px',
              fontSize: 'var(--fs-sm)',
              fontWeight: 500,
              background: kind === 'failure' ? 'var(--danger)' : 'var(--warn, #d97706)',
              color: '#fff',
              border: 'none',
              borderRadius: 'var(--r-md)',
              cursor: loading ? 'wait' : 'pointer',
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? t('generating') : t('generate')}
          </button>
          {error && (
            <div style={{
              marginTop: 'var(--sp-2)',
              fontSize: 'var(--fs-sm)',
              color: 'var(--danger)',
            }}>
              {error}
            </div>
          )}
        </div>
      )}

      {diagnosis && (
        <div data-testid="diagnostic-content">
          <p style={{
            margin: '0 0 var(--sp-3) 0',
            fontSize: 'var(--fs-md)',
            fontWeight: 600,
            color: 'var(--ink-900)',
            lineHeight: 'var(--lh-snug, 1.4)',
          }}>
            {diagnosis.summary}
          </p>

          {diagnosis.root_cause && (
            <div style={{
              marginBottom: 'var(--sp-3)',
              padding: 'var(--sp-3)',
              background: 'rgba(255,255,255,0.5)',
              borderRadius: 'var(--r-sm, 6px)',
              fontSize: 'var(--fs-sm)',
              color: 'var(--ink-700)',
              lineHeight: 'var(--lh-relaxed, 1.55)',
              whiteSpace: 'pre-wrap',
            }}>
              {diagnosis.root_cause}
            </div>
          )}

          {diagnosis.suggestions.length > 0 && (
            <div data-testid="suggestions">
              <h4 style={{
                fontSize: 'var(--fs-sm)',
                fontWeight: 600,
                color: 'var(--ink-900)',
                margin: '0 0 var(--sp-2) 0',
              }}>
                {t('suggestionsHeading')}
              </h4>
              <ol style={{
                margin: 0,
                padding: '0 0 0 20px',
                fontSize: 'var(--fs-sm)',
                color: 'var(--ink-700)',
              }}>
                {diagnosis.suggestions.map((s, i) => (
                  <li key={i} style={{ marginBottom: 'var(--sp-2)' }}>
                    <strong style={{ color: 'var(--ink-900)' }}>{s.title}</strong>
                    {s.body && <div style={{ marginTop: '2px' }}>{s.body}</div>}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {diagnosis.model && (
            <div style={{
              marginTop: 'var(--sp-3)',
              fontSize: 'var(--fs-xs)',
              color: 'var(--ink-500)',
            }}>
              {t('attribution', { model: diagnosis.model })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
