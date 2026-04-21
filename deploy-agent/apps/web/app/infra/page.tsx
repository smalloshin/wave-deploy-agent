'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

interface Overview {
  artifactRegistry: {
    repoName: string;
    region: string;
    sizeBytes: number;
    cleanupPolicyCount: number;
    packages: Array<{ name: string; versionCount: number; updateTime: string | null }>;
  };
  gcsSources: {
    bucket: string;
    prefix: string;
    objectCount: number;
    totalBytes: number;
    lifecycleRuleCount: number;
    objects: Array<{ name: string; sizeBytes: number; timeCreated: string | null; slug: string | null }>;
  };
  cloudRun: Array<{ name: string; url: string | null; ready: boolean; region: string }>;
  orphans: {
    tarballCount: number;
    tarballBytes: number;
    packageCount: number;
    tarballs: Array<{ name: string; sizeBytes: number; slug: string | null }>;
    packages: Array<{ name: string; versionCount: number }>;
  };
}

interface CleanupResult {
  deletedTarballs: number;
  deletedPackages: number;
  freedBytes: number;
  log: Array<{ kind: string; name: string; status: string }>;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function InfraPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const t = useTranslations('infra');
  const tc = useTranslations('common');

  const load = () => {
    setLoading(true);
    fetch(`${API}/api/infra/overview`, { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch((err) => { setError(err.message); setLoading(false); });
  };

  useEffect(() => { load(); }, []);

  const runCleanup = async () => {
    setCleanupBusy(true);
    setCleanupResult(null);
    try {
      const res = await fetch(`${API}/api/infra/cleanup-orphans`, { credentials: 'include', method: 'POST' });
      const json = await res.json();
      setCleanupResult(json);
      setShowConfirm(false);
      load(); // refresh
    } catch (err) {
      alert(t('cleanupFailed', { error: (err as Error).message }));
    } finally {
      setCleanupBusy(false);
    }
  };

  if (loading) return <div style={{ color: 'var(--ink-500)', fontSize: 'var(--fs-md)' }}>{tc('loading')}</div>;
  if (error) return <div style={{ color: 'var(--danger)', fontSize: 'var(--fs-md)' }}>{t('loadFailed', { error })}</div>;
  if (!data) return null;

  const hasOrphans = data.orphans.tarballCount > 0 || data.orphans.packageCount > 0;

  return (
    <div style={{ maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sp-5)' }}>
        <h1 style={{
          fontSize: 'var(--fs-2xl)',
          fontWeight: 700,
          letterSpacing: '-0.02em',
          lineHeight: 'var(--lh-tight)',
          color: 'var(--ink-900)',
        }}>{t('title')}</h1>
        <button onClick={load} className="btn btn-sm">{t('refresh')}</button>
      </div>

      {/* Orphans banner */}
      {hasOrphans && (
        <div style={{
          background: 'var(--warn-bg)',
          border: '1px solid var(--warn)',
          borderRadius: 'var(--r-lg)',
          padding: 'var(--sp-5)',
          marginBottom: 'var(--sp-5)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--sp-4)' }}>
            <div>
              <div style={{ fontSize: 'var(--fs-md)', fontWeight: 600, color: 'var(--warn)', marginBottom: 4 }}>
                {t('orphansFound', { tarballCount: data.orphans.tarballCount, tarballSize: formatBytes(data.orphans.tarballBytes), packageCount: data.orphans.packageCount })}
              </div>
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-700)' }}>
                {t('orphansDescription')}
              </div>
            </div>
            <button
              onClick={() => setShowConfirm(true)}
              className="btn btn-danger"
              style={{ opacity: cleanupBusy ? 0.5 : 1 }}
              disabled={cleanupBusy}
            >
              {cleanupBusy ? t('cleaning') : t('cleanOrphans')}
            </button>
          </div>
        </div>
      )}

      {/* Cleanup result */}
      {cleanupResult && (
        <div style={{
          background: 'var(--ok-bg)',
          border: '1px solid var(--ok)',
          color: 'var(--ok)',
          borderRadius: 'var(--r-md)',
          padding: 'var(--sp-4)',
          marginBottom: 'var(--sp-5)',
          fontSize: 'var(--fs-sm)',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sp-3)',
        }}>
          <span style={{ flex: 1 }}>
            {t('cleanedResult', { tarballs: cleanupResult.deletedTarballs, packages: cleanupResult.deletedPackages, freed: formatBytes(cleanupResult.freedBytes) })}
          </span>
          <button onClick={() => setCleanupResult(null)} style={btnGhost}>{tc('close')}</button>
        </div>
      )}

      {/* Artifact Registry */}
      <Section title="Artifact Registry">
        <Metric label="Repo" value={`${data.artifactRegistry.repoName} · ${data.artifactRegistry.region}`} />
        <Metric label={t('totalCapacity')} value={formatBytes(data.artifactRegistry.sizeBytes)} />
        <Metric label={t('cleanupPolicy')} value={t('policyRules', { count: data.artifactRegistry.cleanupPolicyCount, status: data.artifactRegistry.cleanupPolicyCount > 0 ? '\u2713' : '\u2717' })} />
        <Metric label="Packages" value={`${data.artifactRegistry.packages.length}`} />

        {data.artifactRegistry.packages.length > 0 && (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Package</th>
                <th style={thStyle}>{t('versionCount')}</th>
                <th style={thStyle}>{t('lastUpdated')}</th>
              </tr>
            </thead>
            <tbody>
              {data.artifactRegistry.packages.map((p) => (
                <tr key={p.name}>
                  <td style={tdStyle}><code>{p.name}</code></td>
                  <td style={tdStyle}>{p.versionCount}</td>
                  <td style={{ ...tdStyle, color: 'var(--ink-500)', fontSize: 'var(--fs-sm)' }}>
                    {p.updateTime ? new Date(p.updateTime).toLocaleDateString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* GCS Sources */}
      <Section title={t('cloudStorage')}>
        <Metric label="Bucket" value={`${data.gcsSources.bucket}/${data.gcsSources.prefix}`} />
        <Metric label={t('objectCount')} value={`${data.gcsSources.objectCount}`} />
        <Metric label={t('totalCapacity')} value={formatBytes(data.gcsSources.totalBytes)} />
        <Metric label={t('lifecycle')} value={t('policyRules', { count: data.gcsSources.lifecycleRuleCount, status: data.gcsSources.lifecycleRuleCount > 0 ? '\u2713' : '\u2717' })} />
      </Section>

      {/* Cloud Run */}
      <Section title={t('cloudRunAgent')}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Service</th>
              <th style={thStyle}>{t('serviceStatus')}</th>
              <th style={thStyle}>URL</th>
            </tr>
          </thead>
          <tbody>
            {data.cloudRun.map((s) => (
              <tr key={s.name}>
                <td style={tdStyle}><code>{s.name}</code></td>
                <td style={tdStyle}>
                  <span style={{ color: s.ready ? 'var(--ok)' : 'var(--danger)', fontWeight: 500 }}>
                    {'\u25CF'} {s.ready ? 'Ready' : 'Not Ready'}
                  </span>
                </td>
                <td style={{ ...tdStyle, fontSize: 'var(--fs-sm)' }}>
                  {s.url ? <a href={s.url} target="_blank" rel="noreferrer" style={{ color: 'var(--sea-500)' }}>{s.url}</a> : <span style={{ color: 'var(--ink-400)' }}>—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* Confirm modal */}
      {showConfirm && (
        <div style={modalBackdrop} onClick={() => setShowConfirm(false)}>
          <div style={modalBody} onClick={(e) => e.stopPropagation()}>
            <h3 style={{
              fontSize: 'var(--fs-xl)',
              fontWeight: 700,
              letterSpacing: '-0.02em',
              color: 'var(--ink-900)',
              marginBottom: 'var(--sp-3)',
            }}>{t('confirmCleanup')}</h3>
            <p style={{ fontSize: 'var(--fs-md)', color: 'var(--ink-700)', marginBottom: 'var(--sp-2)' }}>
              {t('willDelete')}
            </p>
            <ul style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-500)', marginBottom: 'var(--sp-4)', paddingLeft: 20 }}>
              <li>{t('gcsTarballs', { count: data.orphans.tarballCount, size: formatBytes(data.orphans.tarballBytes) })}</li>
              <li>{t('arPackages', { count: data.orphans.packageCount })}</li>
            </ul>
            <p style={{
              fontSize: 'var(--fs-sm)',
              color: 'var(--warn)',
              fontWeight: 500,
              marginBottom: 'var(--sp-4)',
              padding: 'var(--sp-3)',
              background: 'var(--warn-bg)',
              borderRadius: 'var(--r-md)',
            }}>
              {t('irreversibleWarning')}
            </p>
            <div style={{ display: 'flex', gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
              <button onClick={() => setShowConfirm(false)} className="btn">{tc('cancel')}</button>
              <button onClick={runCleanup} className="btn btn-danger" disabled={cleanupBusy}>
                {cleanupBusy ? t('cleaning') : t('confirmClean')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--surface-1)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      padding: 'var(--sp-5)',
      marginBottom: 'var(--sp-4)',
    }}>
      <h2 style={{
        fontSize: 'var(--fs-lg)',
        fontWeight: 600,
        letterSpacing: '-0.01em',
        color: 'var(--ink-900)',
        marginBottom: 'var(--sp-4)',
      }}>{title}</h2>
      {children}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      padding: 'var(--sp-2) 0',
      fontSize: 'var(--fs-sm)',
      borderBottom: '1px solid var(--ink-100)',
    }}>
      <span style={{ color: 'var(--ink-500)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono, monospace)', color: 'var(--ink-900)', fontWeight: 500 }}>{value}</span>
    </div>
  );
}

// --- styles ---

const tableStyle: React.CSSProperties = {
  width: '100%',
  marginTop: 'var(--sp-3)',
  borderCollapse: 'collapse',
  fontSize: 'var(--fs-sm)',
};
const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: 'var(--sp-3)',
  borderBottom: '1px solid var(--border)',
  color: 'var(--ink-500)',
  fontWeight: 600,
  fontSize: 'var(--fs-sm)',
};
const tdStyle: React.CSSProperties = {
  padding: 'var(--sp-3)',
  borderBottom: '1px solid var(--ink-100)',
};

const btnGhost: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--ink-500)',
  border: 'none',
  padding: '6px var(--sp-2)',
  fontSize: 'var(--fs-sm)',
  borderRadius: 'var(--r-sm)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};
const modalBackdrop: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(11,14,20,0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100,
};
const modalBody: React.CSSProperties = {
  background: 'var(--surface-1)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-lg)',
  padding: 'var(--sp-6)',
  maxWidth: 520,
  width: '90%',
  boxShadow: 'var(--shadow-md)',
};
