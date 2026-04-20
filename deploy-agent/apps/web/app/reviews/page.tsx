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
      <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>{t('title')}</h2>
      {loading ? (
        <div style={{ color: 'var(--text-secondary)' }}>{tc('loading')}</div>
      ) : reviews.length === 0 ? (
        <div style={{ marginTop: 32, textAlign: 'center', color: 'var(--text-secondary)' }}>
          <p style={{ fontSize: 18 }}>{t('noReviews')}</p>
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: 12 }}>
              <th style={{ padding: '8px 12px', textAlign: 'left' }}>{t('project')}</th>
              <th style={{ padding: '8px 12px', textAlign: 'left' }}>{t('status')}</th>
              <th style={{ padding: '8px 12px', textAlign: 'left' }}>{t('createdDate')}</th>
              <th style={{ padding: '8px 12px', textAlign: 'left' }}>{t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            {reviews.map((r: any) => (
              <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '12px' }}>{r.project_name}</td>
                <td style={{ padding: '12px' }}>
                  <span className={`pill ${r.decision ? (r.decision === 'approved' ? 'pill-live' : 'pill-failed') : 'pill-review'}`}>
                    {r.decision ?? tc('pendingReview')}
                  </span>
                </td>
                <td style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: 13 }}>
                  {new Date(r.created_at).toLocaleDateString()}
                </td>
                <td style={{ padding: '12px' }}>
                  {!r.decision && (
                    <a href={`/reviews/${r.id}`} className="btn" style={{ fontSize: 12 }}>{t('review')}</a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
