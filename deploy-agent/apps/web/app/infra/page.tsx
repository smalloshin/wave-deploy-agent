'use client';

import { useEffect, useState } from 'react';

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

  const load = () => {
    setLoading(true);
    fetch(`${API}/api/infra/overview`)
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch((err) => { setError(err.message); setLoading(false); });
  };

  useEffect(() => { load(); }, []);

  const runCleanup = async () => {
    setCleanupBusy(true);
    setCleanupResult(null);
    try {
      const res = await fetch(`${API}/api/infra/cleanup-orphans`, { method: 'POST' });
      const json = await res.json();
      setCleanupResult(json);
      setShowConfirm(false);
      load(); // refresh
    } catch (err) {
      alert(`清理失敗: ${(err as Error).message}`);
    } finally {
      setCleanupBusy(false);
    }
  };

  if (loading) return <div style={{ color: 'var(--text-secondary)' }}>載入中…</div>;
  if (error) return <div style={{ color: 'var(--status-critical)' }}>載入失敗: {error}</div>;
  if (!data) return null;

  const hasOrphans = data.orphans.tarballCount > 0 || data.orphans.packageCount > 0;

  return (
    <div style={{ maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600 }}>基礎設施</h1>
        <button onClick={load} style={btnSecondary}>🔄 重新整理</button>
      </div>

      {/* Orphans banner */}
      {hasOrphans && (
        <div style={{
          background: 'var(--bg-tertiary)',
          border: '1px solid var(--status-high)',
          borderRadius: 8,
          padding: 16,
          marginBottom: 24,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
                發現孤兒資源 · {data.orphans.tarballCount} 個 tarball ({formatBytes(data.orphans.tarballBytes)}) · {data.orphans.packageCount} 個 AR package
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                這些資源對應的專案已從 DB 刪除，可安全清理
              </div>
            </div>
            <button
              onClick={() => setShowConfirm(true)}
              style={{ ...btnDanger, opacity: cleanupBusy ? 0.5 : 1 }}
              disabled={cleanupBusy}
            >
              {cleanupBusy ? '清理中…' : '清理孤兒資源'}
            </button>
          </div>
        </div>
      )}

      {/* Cleanup result */}
      {cleanupResult && (
        <div style={{
          background: 'var(--bg-tertiary)',
          border: '1px solid var(--status-success)',
          borderRadius: 8,
          padding: 16,
          marginBottom: 24,
          fontSize: 13,
        }}>
          ✓ 已清理 {cleanupResult.deletedTarballs} 個 tarball + {cleanupResult.deletedPackages} 個 AR package，釋放 {formatBytes(cleanupResult.freedBytes)}
          <button onClick={() => setCleanupResult(null)} style={{ marginLeft: 12, ...btnGhost }}>關閉</button>
        </div>
      )}

      {/* Artifact Registry */}
      <Section title="Artifact Registry">
        <Metric label="Repo" value={`${data.artifactRegistry.repoName} · ${data.artifactRegistry.region}`} />
        <Metric label="總容量" value={formatBytes(data.artifactRegistry.sizeBytes)} />
        <Metric label="Cleanup policy" value={`${data.artifactRegistry.cleanupPolicyCount} 條規則 ${data.artifactRegistry.cleanupPolicyCount > 0 ? '✓' : '✗'}`} />
        <Metric label="Packages" value={`${data.artifactRegistry.packages.length}`} />

        {data.artifactRegistry.packages.length > 0 && (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Package</th>
                <th style={thStyle}>版本數</th>
                <th style={thStyle}>最後更新</th>
              </tr>
            </thead>
            <tbody>
              {data.artifactRegistry.packages.map((p) => (
                <tr key={p.name}>
                  <td style={tdStyle}><code>{p.name}</code></td>
                  <td style={tdStyle}>{p.versionCount}</td>
                  <td style={{ ...tdStyle, color: 'var(--text-secondary)', fontSize: 12 }}>
                    {p.updateTime ? new Date(p.updateTime).toLocaleDateString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* GCS Sources */}
      <Section title="Cloud Storage (原始碼)">
        <Metric label="Bucket" value={`${data.gcsSources.bucket}/${data.gcsSources.prefix}`} />
        <Metric label="物件數" value={`${data.gcsSources.objectCount}`} />
        <Metric label="總容量" value={formatBytes(data.gcsSources.totalBytes)} />
        <Metric label="Lifecycle" value={`${data.gcsSources.lifecycleRuleCount} 條規則 ${data.gcsSources.lifecycleRuleCount > 0 ? '✓' : '✗'}`} />
      </Section>

      {/* Cloud Run */}
      <Section title="Cloud Run (Agent 自身)">
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Service</th>
              <th style={thStyle}>狀態</th>
              <th style={thStyle}>URL</th>
            </tr>
          </thead>
          <tbody>
            {data.cloudRun.map((s) => (
              <tr key={s.name}>
                <td style={tdStyle}><code>{s.name}</code></td>
                <td style={tdStyle}>
                  <span style={{ color: s.ready ? 'var(--status-success)' : 'var(--status-critical)' }}>
                    ● {s.ready ? 'Ready' : 'Not Ready'}
                  </span>
                </td>
                <td style={{ ...tdStyle, fontSize: 12 }}>
                  {s.url ? <a href={s.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-blue)' }}>{s.url}</a> : '—'}
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
            <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>確認清理孤兒資源？</h3>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8 }}>
              將刪除：
            </p>
            <ul style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16, paddingLeft: 20 }}>
              <li>{data.orphans.tarballCount} 個 GCS tarball ({formatBytes(data.orphans.tarballBytes)})</li>
              <li>{data.orphans.packageCount} 個 Artifact Registry package</li>
            </ul>
            <p style={{ fontSize: 13, color: 'var(--status-high)', marginBottom: 16 }}>
              這些專案已從 DB 刪除，此操作無法復原。
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowConfirm(false)} style={btnSecondary}>取消</button>
              <button onClick={runCleanup} style={btnDanger} disabled={cleanupBusy}>
                {cleanupBusy ? '清理中…' : '確認清理'}
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
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: 20,
      marginBottom: 16,
    }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>{title}</h2>
      {children}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13 }}>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ fontFamily: 'ui-monospace, monospace' }}>{value}</span>
    </div>
  );
}

// ─── styles ─────────────────────────────────────────────────────────

const tableStyle: React.CSSProperties = {
  width: '100%',
  marginTop: 12,
  borderCollapse: 'collapse',
  fontSize: 13,
};
const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 12px',
  borderBottom: '1px solid var(--border)',
  color: 'var(--text-secondary)',
  fontWeight: 500,
  fontSize: 12,
};
const tdStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid var(--border)',
};

const btnBase: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 6,
  fontSize: 13,
  cursor: 'pointer',
  border: '1px solid var(--border)',
};
const btnSecondary: React.CSSProperties = {
  ...btnBase,
  background: 'var(--bg-tertiary)',
  color: 'var(--text-primary)',
};
const btnDanger: React.CSSProperties = {
  ...btnBase,
  background: 'var(--status-critical)',
  color: 'white',
  border: 'none',
};
const btnGhost: React.CSSProperties = {
  ...btnBase,
  background: 'transparent',
  color: 'var(--text-secondary)',
  border: 'none',
  padding: '4px 8px',
};
const modalBackdrop: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.6)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100,
};
const modalBody: React.CSSProperties = {
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: 24,
  maxWidth: 480,
  width: '90%',
};
