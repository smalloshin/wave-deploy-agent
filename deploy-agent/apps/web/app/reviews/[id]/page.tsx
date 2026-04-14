'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

interface Finding {
  id: string;
  tool: string;
  category: string;
  severity: string;
  title: string;
  description: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  action: string;
}

interface ReviewData {
  id: string;
  project_id: string;
  project_name: string;
  project_slug: string;
  decision: string | null;
  reviewer_email: string | null;
  comments: string | null;
  threat_summary: string | null;
  cost_estimate: { monthlyTotal: number; breakdown: { compute: number; storage: number; networking: number; ssl: number } } | null;
  semgrep_findings: Finding[] | null;
  trivy_findings: Finding[] | null;
  llm_analysis: { summary: string; findings: Finding[]; autoFixes: { filePath: string; explanation: string }[] } | null;
  auto_fixes: { applied: boolean; diff: string; explanation: string }[] | null;
  created_at: string;
  reviewed_at: string | null;
}

export default function ReviewDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const [review, setReview] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const t = useTranslations('reviewDetail');
  const tc = useTranslations('common');

  // Decision form
  const [decision, setDecision] = useState<'approved' | 'rejected' | ''>('');
  const [email, setEmail] = useState('');
  const [comments, setComments] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`${API}/api/reviews/${id}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => { setReview(d.review); setLoading(false); })
      .catch((err) => { setError(err.message); setLoading(false); });
  }, [id]);

  const handleSubmit = async () => {
    if (!decision) { setError(t('selectDecisionError')); return; }
    if (!email.trim()) { setError(t('emailRequiredError')); return; }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/reviews/${id}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, reviewerEmail: email.trim(), comments: comments.trim() || undefined }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? `HTTP ${res.status}`); }
      router.push('/reviews');
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div>
        <BackLink t={t} />
        <div style={{ marginTop: 24, color: 'var(--text-secondary)' }}>{t('loadingReview')}</div>
      </div>
    );
  }

  if (!review) {
    return (
      <div>
        <BackLink t={t} />
        <div style={{ marginTop: 24, padding: 16, background: 'rgba(248,81,73,0.1)', borderRadius: 6, border: '1px solid var(--status-critical)' }}>
          {t('notFound')} <button className="btn" onClick={() => router.push('/reviews')}>{t('returnBtn')}</button>
        </div>
      </div>
    );
  }

  const semgrepFindings: Finding[] = Array.isArray(review.semgrep_findings) ? review.semgrep_findings : [];
  const trivyFindings: Finding[] = Array.isArray(review.trivy_findings) ? review.trivy_findings : [];
  const llmFindings: Finding[] = review.llm_analysis?.findings ?? [];
  const allFindings = [...semgrepFindings, ...trivyFindings, ...llmFindings];
  const autoFixes = Array.isArray(review.auto_fixes) ? review.auto_fixes : [];
  const alreadyDecided = !!review.decision;

  const severityCounts = allFindings.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div>
      <BackLink t={t} />

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
        <h2 style={{ fontSize: 22, fontWeight: 600 }}>{t('reviewTitle', { name: review.project_name })}</h2>
        {alreadyDecided && (
          <span className={`pill ${review.decision === 'approved' ? 'pill-live' : 'pill-failed'}`}>
            {review.decision}
          </span>
        )}
      </div>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 4 }}>
        {t('createdAt', { time: new Date(review.created_at).toLocaleString() })}
        {review.reviewed_at && ` · ${t('reviewedAt', { time: new Date(review.reviewed_at).toLocaleString(), email: review.reviewer_email ?? '' })}`}
      </p>

      {/* Summary Stats */}
      <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
        <StatCard label={t('totalFindings')} value={String(allFindings.length)} />
        <StatCard label={t('critical')} value={String(severityCounts['critical'] ?? 0)}
          color={severityCounts['critical'] ? 'var(--status-critical)' : undefined} />
        <StatCard label={t('high')} value={String(severityCounts['high'] ?? 0)}
          color={severityCounts['high'] ? '#f0883e' : undefined} />
        <StatCard label={t('medium')} value={String(severityCounts['medium'] ?? 0)} />
        <StatCard label={t('lowInfo')} value={String((severityCounts['low'] ?? 0) + (severityCounts['info'] ?? 0))} />
        <StatCard label={t('autoFixes')} value={`${autoFixes.filter((f) => f.applied).length}/${autoFixes.length}`} />
        {review.cost_estimate && (
          <StatCard label={t('estimatedCost')} value={`$${review.cost_estimate.monthlyTotal.toFixed(2)}/mo`} />
        )}
      </div>

      {/* Threat Summary */}
      {review.threat_summary && (
        <Card title={t('threatSummary')} style={{ marginTop: 16 }}>
          <div style={{
            background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 6,
            padding: 12, fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: 300,
            overflowY: 'auto', fontFamily: 'monospace',
          }}>
            {review.threat_summary}
          </div>
        </Card>
      )}

      {/* Findings Table */}
      {allFindings.length > 0 && (
        <Card title={t('findings', { count: allFindings.length })} style={{ marginTop: 16 }}>
          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: 11, textTransform: 'uppercase' }}>
                  <th style={{ padding: '6px 8px', textAlign: 'left' }}>{t('severity')}</th>
                  <th style={{ padding: '6px 8px', textAlign: 'left' }}>{t('tool')}</th>
                  <th style={{ padding: '6px 8px', textAlign: 'left' }}>{t('findingTitle')}</th>
                  <th style={{ padding: '6px 8px', textAlign: 'left' }}>{t('file')}</th>
                  <th style={{ padding: '6px 8px', textAlign: 'left' }}>{t('action')}</th>
                </tr>
              </thead>
              <tbody>
                {allFindings.map((f, i) => (
                  <tr key={f.id ?? i} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px' }}>
                      <SeverityBadge severity={f.severity} />
                    </td>
                    <td style={{ padding: '8px', color: 'var(--text-secondary)' }}>{f.tool}</td>
                    <td style={{ padding: '8px' }}>
                      <div style={{ fontWeight: 500 }}>{f.title}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{f.description?.slice(0, 120)}</div>
                    </td>
                    <td style={{ padding: '8px', fontFamily: 'monospace', fontSize: 12, color: 'var(--text-secondary)' }}>
                      {f.filePath}{f.lineStart ? `:${f.lineStart}` : ''}
                    </td>
                    <td style={{ padding: '8px' }}>
                      <span style={{
                        fontSize: 11, padding: '2px 6px', borderRadius: 4,
                        background: f.action === 'auto_fix' ? 'rgba(63,185,80,0.15)' : 'rgba(255,255,255,0.05)',
                        color: f.action === 'auto_fix' ? 'var(--status-live)' : 'var(--text-secondary)',
                      }}>
                        {f.action === 'auto_fix' ? t('autoFixApplied') : tc('pending')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Auto-Fixes */}
      {autoFixes.length > 0 && (
        <Card title={t('autoFixSection', { applied: autoFixes.filter((f) => f.applied).length })} style={{ marginTop: 16 }}>
          {autoFixes.map((fix, i) => (
            <div key={i} style={{
              marginBottom: 12, padding: 10, background: 'var(--bg-primary)',
              borderRadius: 6, border: '1px solid var(--border)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span>{fix.applied ? '\u2705' : '\u26A0\uFE0F'}</span>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{fix.explanation}</span>
              </div>
              {fix.diff && (
                <pre style={{
                  fontSize: 11, fontFamily: 'monospace', color: 'var(--text-secondary)',
                  whiteSpace: 'pre-wrap', margin: 0, marginTop: 4,
                  padding: 8, background: 'rgba(0,0,0,0.15)', borderRadius: 4,
                }}>
                  {fix.diff}
                </pre>
              )}
            </div>
          ))}
        </Card>
      )}

      {/* Decision Form */}
      {!alreadyDecided && (
        <Card title={t('submitDecision')} style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
            <button
              type="button"
              className={`btn ${decision === 'approved' ? 'btn-primary' : ''}`}
              onClick={() => setDecision('approved')}
              style={{
                flex: 1, padding: '10px', fontSize: 14,
                ...(decision === 'approved' ? { background: 'var(--status-live)', borderColor: 'var(--status-live)' } : {}),
              }}
            >
              {t('approve')}
            </button>
            <button
              type="button"
              className={`btn ${decision === 'rejected' ? 'btn-primary' : ''}`}
              onClick={() => setDecision('rejected')}
              style={{
                flex: 1, padding: '10px', fontSize: 14,
                ...(decision === 'rejected' ? { background: 'var(--status-critical)', borderColor: 'var(--status-critical)' } : {}),
              }}
            >
              {t('reject')}
            </button>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 13, marginBottom: 4, color: 'var(--text-secondary)' }}>
              {t('reviewerEmail')}
            </label>
            <input
              type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              style={{
                width: '100%', padding: '8px 12px',
                background: 'var(--bg-primary)', border: '1px solid var(--border)',
                borderRadius: 6, color: 'var(--text-primary)', fontSize: 14,
              }}
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 13, marginBottom: 4, color: 'var(--text-secondary)' }}>
              {t('notesOptional')}
            </label>
            <textarea
              value={comments} onChange={(e) => setComments(e.target.value)}
              rows={3} placeholder={t('notesPlaceholder')}
              style={{
                width: '100%', padding: '8px 12px',
                background: 'var(--bg-primary)', border: '1px solid var(--border)',
                borderRadius: 6, color: 'var(--text-primary)', fontSize: 14,
                resize: 'vertical',
              }}
            />
          </div>

          {error && (
            <div style={{ padding: 8, marginBottom: 12, background: 'rgba(248,81,73,0.1)', borderRadius: 6, color: 'var(--status-critical)', fontSize: 13 }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={handleSubmit} disabled={submitting || !decision}
              style={{ padding: '8px 24px', fontSize: 14 }}>
              {submitting ? t('submitting') : t('submitLabel', { decision: decision || '...' })}
            </button>
          </div>
        </Card>
      )}

      {/* Already decided info */}
      {alreadyDecided && (
        <Card title={t('reviewResult')} style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', gap: 16 }}>
            <div>
              <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{t('result')}</span>
              <span className={`pill ${review.decision === 'approved' ? 'pill-live' : 'pill-failed'}`}>
                {review.decision}
              </span>
            </div>
            {review.reviewer_email && (
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                by {review.reviewer_email}
              </div>
            )}
          </div>
          {review.comments && (
            <div style={{ marginTop: 8, padding: 10, background: 'var(--bg-primary)', borderRadius: 6, fontSize: 13 }}>
              {review.comments}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

/* --- Sub-components --- */

function BackLink({ t }: { t: (key: string) => string }) {
  return (
    <a href="/reviews" style={{ color: 'var(--text-secondary)', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      &larr; {t('backToReviews')}
    </a>
  );
}

function Card({ title, children, style }: { title: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8,
      padding: 16, ...style,
    }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, textTransform: 'uppercase', color: 'var(--text-secondary)', letterSpacing: 0.5 }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{
      flex: 1, padding: '12px 16px', background: 'var(--bg-secondary)', borderRadius: 8,
      border: '1px solid var(--border)', textAlign: 'center',
    }}>
      <div style={{ fontSize: 22, fontWeight: 600, color: color ?? 'var(--text-primary)' }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', marginTop: 2 }}>{label}</div>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const colors: Record<string, string> = {
    critical: '#f85149',
    high: '#f0883e',
    medium: '#d29922',
    low: '#58a6ff',
    info: '#8b949e',
  };
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11,
      fontWeight: 600, textTransform: 'uppercase',
      background: `${colors[severity] ?? '#8b949e'}20`,
      color: colors[severity] ?? '#8b949e',
    }}>
      {severity}
    </span>
  );
}
