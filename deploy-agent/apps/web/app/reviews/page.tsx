'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export default function ReviewsPage() {
  const [reviews, setReviews] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const t = useTranslations('reviews');
  const tc = useTranslations('common');

  const loadReviews = (silent = false) => {
    if (!silent) setLoading(true);
    fetch(`${API}/api/reviews`, { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => { setReviews(data.reviews); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => {
    loadReviews();
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      loadReviews(true);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      <h2 style={{
        fontSize: 'var(--fs-2xl)',
        fontWeight: 700,
        letterSpacing: '-0.02em',
        lineHeight: 'var(--lh-tight)',
        color: 'var(--ink-900)',
        marginBottom: 'var(--sp-5)',
      }}>{t('title')}</h2>
      {loading ? (
        <div style={{ color: 'var(--ink-500)', fontSize: 'var(--fs-md)' }}>{tc('loading')}</div>
      ) : reviews.length === 0 ? (
        <div style={{
          marginTop: 'var(--sp-6)',
          textAlign: 'center',
          padding: 'var(--sp-7) var(--sp-5)',
          background: 'var(--surface-1)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-lg)',
        }}>
          <p style={{ fontSize: 'var(--fs-lg)', color: 'var(--ink-900)', fontWeight: 600 }}>{t('noReviews')}</p>
        </div>
      ) : (
        <div style={{
          background: 'var(--surface-1)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-lg)',
          overflow: 'hidden',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{
                borderBottom: '1px solid var(--border)',
                color: 'var(--ink-500)',
                fontSize: 'var(--fs-sm)',
                background: 'var(--ink-50)',
              }}>
                <th style={{ padding: 'var(--sp-3) var(--sp-4)', textAlign: 'left', fontWeight: 600 }}>{t('project')}</th>
                <th style={{ padding: 'var(--sp-3) var(--sp-4)', textAlign: 'left', fontWeight: 600 }}>{t('status')}</th>
                <th style={{ padding: 'var(--sp-3) var(--sp-4)', textAlign: 'left', fontWeight: 600 }}>{t('createdDate')}</th>
                <th style={{ padding: 'var(--sp-3) var(--sp-4)', textAlign: 'left', fontWeight: 600 }}>{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {reviews.map((r: any) => (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--ink-100)' }}>
                  <td style={{ padding: 'var(--sp-4)', fontSize: 'var(--fs-md)', color: 'var(--ink-900)', fontWeight: 500 }}>{r.project_name}</td>
                  <td style={{ padding: 'var(--sp-4)' }}>
                    <span className={`pill ${r.decision ? (r.decision === 'approved' ? 'pill-live' : 'pill-failed') : 'pill-review'}`}>
                      {r.decision ?? tc('pendingReview')}
                    </span>
                  </td>
                  <td style={{ padding: 'var(--sp-4)', color: 'var(--ink-500)', fontSize: 'var(--fs-sm)' }}>
                    {new Date(r.created_at).toLocaleDateString()}
                  </td>
                  <td style={{ padding: 'var(--sp-4)' }}>
                    {!r.decision && (
                      <a href={`/reviews/${r.id}`} className="btn btn-sm">{t('review')}</a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
