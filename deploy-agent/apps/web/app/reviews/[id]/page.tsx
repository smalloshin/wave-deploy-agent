'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import ReactMarkdown from 'react-markdown';
import { useAuth } from '../../../lib/auth';

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
  const { user } = useAuth();
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

  // Pre-fill reviewer email from logged-in user
  useEffect(() => {
    if (user?.email && !email) setEmail(user.email);
  }, [user, email]);

  useEffect(() => {
    fetch(`${API}/api/reviews/${id}`, { credentials: 'include' })
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
      const res = await fetch(`${API}/api/reviews/${id}/decide`, { credentials: 'include', method: 'POST',
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
        <div style={{ marginTop: 'var(--sp-5)', color: 'var(--ink-500)', fontSize: 'var(--fs-md)' }}>{t('loadingReview')}</div>
      </div>
    );
  }

  if (!review) {
    return (
      <div>
        <BackLink t={t} />
        <div style={{
          marginTop: 'var(--sp-5)',
          padding: 'var(--sp-4)',
          background: 'var(--danger-bg)',
          borderRadius: 'var(--r-md)',
          border: '1px solid var(--danger)',
          color: 'var(--danger)',
          fontSize: 'var(--fs-md)',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sp-3)',
        }}>
          {t('notFound')} <button className="btn btn-sm" onClick={() => router.push('/reviews')}>{t('returnBtn')}</button>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', marginTop: 'var(--sp-3)', flexWrap: 'wrap' }}>
        <h2 style={{
          fontSize: 'var(--fs-2xl)',
          fontWeight: 700,
          letterSpacing: '-0.02em',
          lineHeight: 'var(--lh-tight)',
          color: 'var(--ink-900)',
        }}>{t('reviewTitle', { name: review.project_name })}</h2>
        {alreadyDecided && (
          <span className={`pill ${review.decision === 'approved' ? 'pill-live' : 'pill-failed'}`}>
            {review.decision}
          </span>
        )}
      </div>
      <p style={{ color: 'var(--ink-500)', fontSize: 'var(--fs-sm)', marginTop: 'var(--sp-2)' }}>
        {t('createdAt', { time: new Date(review.created_at).toLocaleString() })}
        {review.reviewed_at && ` · ${t('reviewedAt', { time: new Date(review.reviewed_at).toLocaleString(), email: review.reviewer_email ?? '' })}`}
      </p>

      {/* Summary Stats */}
      <div style={{ display: 'flex', gap: 'var(--sp-3)', marginTop: 'var(--sp-5)', flexWrap: 'wrap' }}>
        <StatCard label={t('totalFindings')} value={String(allFindings.length)} />
        <StatCard label={t('critical')} value={String(severityCounts['critical'] ?? 0)}
          color={severityCounts['critical'] ? 'var(--danger)' : undefined} />
        <StatCard label={t('high')} value={String(severityCounts['high'] ?? 0)}
          color={severityCounts['high'] ? 'var(--warn)' : undefined} />
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
          <div className="markdown-body" style={{
            background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 6,
            padding: 12, fontSize: 13, lineHeight: 1.6, maxHeight: 300,
            overflowY: 'auto',
          }}>
            <ReactMarkdown>{review.threat_summary}</ReactMarkdown>
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
                        fontSize: 'var(--fs-xs)', padding: '2px 6px', borderRadius: 'var(--r-sm)',
                        background: f.action === 'auto_fix' ? 'var(--ok-bg)' : 'var(--ink-100)',
                        color: f.action === 'auto_fix' ? 'var(--ok)' : 'var(--ink-500)',
                        fontWeight: 600,
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
                  fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono, monospace)', color: 'var(--ink-700)',
                  whiteSpace: 'pre-wrap', margin: 0, marginTop: 4,
                  padding: 'var(--sp-3)', background: 'var(--ink-50)', borderRadius: 'var(--r-sm)',
                  border: '1px solid var(--ink-100)',
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
        <Card title={t('submitDecision')} style={{ marginTop: 'var(--sp-4)' }}>
          <div style={{ display: 'flex', gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)' }}>
            <button
              type="button"
              className="btn"
              onClick={() => setDecision('approved')}
              style={{
                flex: 1,
                justifyContent: 'center',
                ...(decision === 'approved' ? {
                  background: 'var(--ok)',
                  borderColor: 'var(--ok)',
                  color: 'var(--text-inverse)',
                } : {}),
              }}
            >
              {t('approve')}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setDecision('rejected')}
              style={{
                flex: 1,
                justifyContent: 'center',
                ...(decision === 'rejected' ? {
                  background: 'var(--danger)',
                  borderColor: 'var(--danger)',
                  color: 'var(--text-inverse)',
                } : {}),
              }}
            >
              {t('reject')}
            </button>
          </div>

          <div style={{ marginBottom: 'var(--sp-3)' }}>
            <label style={{
              display: 'block',
              fontSize: 'var(--fs-sm)',
              fontWeight: 500,
              marginBottom: 6,
              color: 'var(--ink-700)',
            }}>
              {t('reviewerEmail')}
            </label>
            <input
              type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              style={{
                width: '100%',
                padding: '10px var(--sp-3)',
                background: 'var(--surface-1)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-md)',
                color: 'var(--ink-900)',
                fontSize: 'var(--fs-md)',
                fontFamily: 'inherit',
                outline: 'none',
              }}
            />
          </div>

          <div style={{ marginBottom: 'var(--sp-3)' }}>
            <label style={{
              display: 'block',
              fontSize: 'var(--fs-sm)',
              fontWeight: 500,
              marginBottom: 6,
              color: 'var(--ink-700)',
            }}>
              {t('notesOptional')}
            </label>
            <textarea
              value={comments} onChange={(e) => setComments(e.target.value)}
              rows={3} placeholder={t('notesPlaceholder')}
              style={{
                width: '100%',
                padding: '10px var(--sp-3)',
                background: 'var(--surface-1)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-md)',
                color: 'var(--ink-900)',
                fontSize: 'var(--fs-md)',
                fontFamily: 'inherit',
                resize: 'vertical',
                outline: 'none',
              }}
            />
          </div>

          {error && (
            <div style={{
              padding: 'var(--sp-3)',
              marginBottom: 'var(--sp-3)',
              background: 'var(--danger-bg)',
              border: '1px solid var(--danger)',
              borderRadius: 'var(--r-md)',
              color: 'var(--danger)',
              fontSize: 'var(--fs-sm)',
            }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={handleSubmit} disabled={submitting || !decision}>
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
    <a href="/reviews" style={{
      color: 'var(--ink-500)',
      fontSize: 'var(--fs-sm)',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      fontWeight: 500,
    }}>
      &larr; {t('backToReviews')}
    </a>
  );
}

function Card({ title, children, style }: { title: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: 'var(--surface-1)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      padding: 'var(--sp-5)',
      ...style,
    }}>
      <h3 style={{
        fontSize: 'var(--fs-lg)',
        fontWeight: 600,
        letterSpacing: '-0.01em',
        marginBottom: 'var(--sp-4)',
        color: 'var(--ink-900)',
      }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{
      flex: '1 1 130px',
      padding: 'var(--sp-4) var(--sp-4)',
      background: 'var(--surface-1)',
      borderRadius: 'var(--r-lg)',
      border: '1px solid var(--border)',
      textAlign: 'center',
    }}>
      <div style={{
        fontSize: 'var(--fs-2xl)',
        fontWeight: 700,
        letterSpacing: '-0.02em',
        color: color ?? 'var(--ink-900)',
        lineHeight: 'var(--lh-tight)',
      }}>{value}</div>
      <div style={{
        fontSize: 'var(--fs-xs)',
        color: 'var(--ink-500)',
        textTransform: 'uppercase',
        marginTop: 4,
        letterSpacing: '0.05em',
        fontWeight: 500,
      }}>{label}</div>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, { bg: string; color: string }> = {
    critical: { bg: 'var(--danger-bg)', color: 'var(--danger)' },
    high: { bg: 'var(--warn-bg)', color: 'var(--warn)' },
    medium: { bg: 'var(--warn-bg)', color: 'var(--warn)' },
    low: { bg: 'var(--info-bg)', color: 'var(--info)' },
    info: { bg: 'var(--ink-100)', color: 'var(--ink-500)' },
  };
  const s = map[severity] ?? map['info'];
  return (
    <span style={{
      display: 'inline-block',
      padding: '3px var(--sp-2)',
      borderRadius: 'var(--r-sm)',
      fontSize: 'var(--fs-xs)',
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.03em',
      background: s.bg,
      color: s.color,
    }}>
      {severity}
    </span>
  );
}
