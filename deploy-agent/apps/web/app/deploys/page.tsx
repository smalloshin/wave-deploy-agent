'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const PAGE_SIZE = 20;

export default function DeploysPage() {
  const [deployments, setDeployments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const t = useTranslations('deploys');
  const tc = useTranslations('common');

  const loadDeployments = (silent = false) => {
    if (!silent) setLoading(true);
    fetch(`${API}/api/deploys`, { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => { setDeployments(data.deployments); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => {
    loadDeployments();
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      loadDeployments(true);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const totalPages = Math.ceil(deployments.length / PAGE_SIZE);
  const paged = deployments.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

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
      ) : deployments.length === 0 ? (
        <div style={{
          marginTop: 'var(--sp-6)',
          textAlign: 'center',
          padding: 'var(--sp-7) var(--sp-5)',
          background: 'var(--surface-1)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-lg)',
        }}>
          <p style={{ fontSize: 'var(--fs-lg)', color: 'var(--ink-900)', fontWeight: 600, marginBottom: 'var(--sp-2)' }}>{t('noDeployments')}</p>
          <p style={{ fontSize: 'var(--fs-md)', color: 'var(--ink-500)' }}>{t('noDeploymentsHint')}</p>
        </div>
      ) : (
        <>
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
                  <th style={{ padding: 'var(--sp-3) var(--sp-4)', textAlign: 'left', fontWeight: 600 }}>{t('customDomain')}</th>
                  <th style={{ padding: 'var(--sp-3) var(--sp-4)', textAlign: 'left', fontWeight: 600 }}>{t('cloudRunUrl')}</th>
                  <th style={{ padding: 'var(--sp-3) var(--sp-4)', textAlign: 'left', fontWeight: 600 }}>{t('healthStatus')}</th>
                  <th style={{ padding: 'var(--sp-3) var(--sp-4)', textAlign: 'left', fontWeight: 600 }}>{t('deployTime')}</th>
                  <th style={{ padding: 'var(--sp-3) var(--sp-4)', textAlign: 'left', fontWeight: 600 }} aria-label={t('viewTimeline')} />
                </tr>
              </thead>
              <tbody>
                {paged.map((d: any) => (
                  <tr key={d.id} style={{ borderBottom: '1px solid var(--ink-100)' }}>
                    <td style={{ padding: 'var(--sp-4)' }}>
                      <a href={`/projects/${d.project_id}`} style={{
                        color: 'var(--ink-900)',
                        textDecoration: 'none',
                        fontWeight: 600,
                        fontSize: 'var(--fs-md)',
                      }}>
                        {d.project_name}
                      </a>
                    </td>
                    <td style={{ padding: 'var(--sp-4)' }}>
                      {d.custom_domain ? (
                        <a href={`https://${d.custom_domain}`} target="_blank" className="mono" style={{ fontSize: 'var(--fs-sm)', color: 'var(--sea-500)' }}>
                          {d.custom_domain}
                        </a>
                      ) : <span style={{ color: 'var(--ink-400)' }}>—</span>}
                    </td>
                    <td style={{ padding: 'var(--sp-4)' }}>
                      {d.cloud_run_url ? (
                        <a href={d.cloud_run_url} target="_blank" className="mono" style={{ fontSize: 'var(--fs-sm)', color: 'var(--sea-500)' }}>
                          {d.cloud_run_url}
                        </a>
                      ) : <span style={{ color: 'var(--ink-400)' }}>—</span>}
                    </td>
                    <td style={{ padding: 'var(--sp-4)' }}>
                      <span className={`pill ${d.health_status === 'healthy' ? 'pill-live' : d.health_status === 'unhealthy' ? 'pill-failed' : ''}`}>
                        {d.health_status}
                      </span>
                    </td>
                    <td style={{ padding: 'var(--sp-4)', color: 'var(--ink-500)', fontSize: 'var(--fs-sm)' }}>
                      {d.deployed_at ? new Date(d.deployed_at).toLocaleString() : tc('waiting')}
                    </td>
                    <td style={{ padding: 'var(--sp-4)' }}>
                      <a href={`/deploys/${d.id}`} style={{
                        fontSize: 'var(--fs-sm)',
                        color: 'var(--sea-500)',
                        textDecoration: 'none',
                      }}>
                        {t('viewTimeline')} →
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--sp-3)', marginTop: 'var(--sp-5)' }}>
              <button className="btn btn-sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
                &larr;
              </button>
              <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-500)' }}>
                {page + 1} / {totalPages}
              </span>
              <button className="btn btn-sm" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>
                &rarr;
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
