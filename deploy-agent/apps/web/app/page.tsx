'use client';

import { useEffect, useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

interface Project {
  id: string;
  name: string;
  slug: string;
  status: string;
  detectedLanguage: string | null;
  detectedFramework: string | null;
  sourceType: string;
  createdAt: string;
  updatedAt: string;
  config?: Record<string, unknown>;
}

interface ProjectResource {
  kind: 'cloud_run' | 'redis_db' | 'postgres_db' | 'gcs_source' | 'custom_domain';
  label: string;
  detail?: string;
  reference?: string;
  removable: boolean;
}

interface ProjectWithResources extends Project {
  resources: ProjectResource[];
  latestDeployment: {
    cloudRunService: string | null;
    cloudRunUrl: string | null;
    customDomain: string | null;
    deployedAt: string | null;
  } | null;
}

interface ProjectGroup {
  groupId: string;
  groupName: string;
  createdAt: string;
  updatedAt: string;
  serviceCount: number;
  liveCount: number;
  stoppedCount: number;
  failedCount: number;
  services: ProjectWithResources[];
}

export default function ProjectsPage() {
  const [groups, setGroups] = useState<ProjectGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteLog, setDeleteLog] = useState<{ step: string; status: string; error?: string }[] | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Record<string, Set<string>>>({}); // groupId -> set of serviceIds
  const [actionBusy, setActionBusy] = useState<string | null>(null); // "groupId:action" lock

  const loadGroups = (silent = false) => {
    if (!silent) setLoading(true);
    fetch(`${API}/api/project-groups`)
      .then((r) => r.json())
      .then((data) => { setGroups(data.groups ?? []); setLoading(false); })
      .catch((err) => { setError(err.message); setLoading(false); });
  };

  const loadProjects = loadGroups; // back-compat for existing callers (modals)

  const toggleExpand = (gid: string) =>
    setExpanded((p) => ({ ...p, [gid]: !p[gid] }));

  const toggleSelect = (gid: string, sid: string) => {
    setSelected((prev) => {
      const next = { ...prev };
      const set = new Set(next[gid] ?? []);
      if (set.has(sid)) set.delete(sid); else set.add(sid);
      next[gid] = set;
      return next;
    });
  };

  const runGroupAction = async (group: ProjectGroup, action: 'stop' | 'start') => {
    const sel = selected[group.groupId];
    const serviceIds = sel && sel.size > 0 ? Array.from(sel) : undefined;
    const key = `${group.groupId}:${action}`;
    setActionBusy(key);
    try {
      const res = await fetch(`${API}/api/project-groups/${group.groupId}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, serviceIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const failed = (data.results ?? []).filter((r: { success: boolean }) => !r.success);
      if (failed.length > 0) {
        alert(`${failed.length} / ${(data.results ?? []).length} 失敗：\n` +
          failed.map((r: { name: string; message: string }) => `- ${r.name}: ${r.message}`).join('\n'));
      }
      loadGroups(true);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setActionBusy(null);
    }
  };

  const runServiceAction = async (projectId: string, action: 'stop' | 'start') => {
    const key = `svc:${projectId}:${action}`;
    setActionBusy(key);
    try {
      const res = await fetch(`${API}/api/projects/${projectId}/${action}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      loadGroups(true);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setActionBusy(null);
    }
  };

  useEffect(() => {
    loadGroups();
    const interval = setInterval(() => loadGroups(true), 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div>
        <Header onSubmit={() => setShowModal(true)} />
        <div style={{ marginTop: 24 }}>
          {[1, 2, 3].map((i) => (
            <div key={i} style={{
              height: 48, background: 'var(--bg-secondary)', borderRadius: 6,
              marginBottom: 8, animation: 'pulse 1.5s ease-in-out infinite',
            }} />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <Header onSubmit={() => setShowModal(true)} />
        <div style={{ marginTop: 24, padding: 16, background: 'rgba(248,81,73,0.1)', borderRadius: 6, border: '1px solid var(--status-critical)' }}>
          <p>載入專案失敗。 <button className="btn" onClick={() => window.location.reload()}>重試</button></p>
        </div>
        {showModal && (
          <SubmitModal
            onClose={() => setShowModal(false)}
            onSubmitted={() => { setShowModal(false); loadProjects(); }}
          />
        )}
      </div>
    );
  }

  return (
    <div>
      <Header onSubmit={() => setShowModal(true)} />
      {groups.length === 0 ? (
        <div style={{ marginTop: 48, textAlign: 'center', color: 'var(--text-secondary)' }}>
          <p style={{ fontSize: 18, marginBottom: 8 }}>尚無專案</p>
          <p>提交你的第一個專案以開始使用。</p>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setShowModal(true)}>
            + 提交專案
          </button>
        </div>
      ) : (
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {groups.map((g) => (
            <GroupCard
              key={g.groupId}
              group={g}
              expanded={!!expanded[g.groupId]}
              selected={selected[g.groupId] ?? new Set()}
              actionBusy={actionBusy}
              onToggleExpand={() => toggleExpand(g.groupId)}
              onToggleSelect={(sid) => toggleSelect(g.groupId, sid)}
              onGroupAction={(action) => runGroupAction(g, action)}
              onServiceAction={runServiceAction}
              onDeleteService={(svc) => { setDeleteTarget(svc); setDeleteLog(null); }}
            />
          ))}
        </div>
      )}
      {showModal && (
        <SubmitModal
          onClose={() => setShowModal(false)}
          onSubmitted={() => { setShowModal(false); loadProjects(); }}
        />
      )}
      {deleteTarget && (
        <DeleteModal
          project={deleteTarget}
          deleting={deleting}
          deleteLog={deleteLog}
          onClose={() => { setDeleteTarget(null); setDeleteLog(null); setDeleting(false); }}
          onConfirm={async () => {
            setDeleting(true);
            setDeleteLog(null);
            try {
              const res = await fetch(`${API}/api/projects/${deleteTarget.id}`, { method: 'DELETE' });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
              setDeleteLog(data.teardownLog ?? []);
              // Reload after short delay so user can see the log
              setTimeout(() => {
                setDeleteTarget(null);
                setDeleteLog(null);
                setDeleting(false);
                loadProjects();
              }, 2000);
            } catch (err) {
              setDeleteLog([{ step: 'Request failed', status: 'error', error: (err as Error).message }]);
              setDeleting(false);
            }
          }}
        />
      )}
    </div>
  );
}

function Header({ onSubmit }: { onSubmit: () => void }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <h2 style={{ fontSize: 20, fontWeight: 600 }}>專案</h2>
      <button className="btn btn-primary" onClick={onSubmit}>
        + 提交專案
      </button>
    </div>
  );
}

function SubmitModal({ onClose, onSubmitted }: { onClose: () => void; onSubmitted: () => void }) {
  const [name, setName] = useState('');
  const [sourceType, setSourceType] = useState<'upload' | 'git'>('upload');
  const [gitUrl, setGitUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [customDomain, setCustomDomain] = useState('');
  const [allowUnauth] = useState(true); // Always public — deploy agent projects are meant for public access
  const [envVarsText, setEnvVarsText] = useState('');
  const [dbDumpFile, setDbDumpFile] = useState<File | null>(null);
  const [showEnvVars, setShowEnvVars] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [domainConflict, setDomainConflict] = useState<{ fqdn: string; existingRoute: string } | null>(null);

  const handleFile = (f: File) => {
    const validTypes = ['.zip', '.tar.gz', '.tgz', '.tar'];
    const isValid = validTypes.some((ext) => f.name.toLowerCase().endsWith(ext));
    if (!isValid) {
      setError('請上傳 .zip、.tar.gz 或 .tar 檔案');
      return;
    }
    setFile(f);
    setError(null);
    // Auto-fill project name from filename if empty
    if (!name.trim()) {
      const baseName = f.name.replace(/\.(zip|tar\.gz|tgz|tar)$/i, '');
      setName(baseName);
    }
  };

  const GCS_UPLOAD_THRESHOLD = 30 * 1024 * 1024; // 30MB — Cloud Run limit is 32MB

  const doSubmit = async (forceDomain: boolean) => {
    setSubmitting(true);
    setError(null);
    setDomainConflict(null);

    try {
      // For large files: upload to GCS first, then submit via JSON
      if (sourceType === 'upload' && file && file.size > GCS_UPLOAD_THRESHOLD) {
        setError(null);

        // Step 1: Get GCS upload URL from API
        const initRes = await fetch(`${API}/api/upload/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: file.name, contentType: file.type || 'application/octet-stream' }),
        });
        if (!initRes.ok) {
          const data = await initRes.json();
          throw new Error(data.error ?? `Init failed: HTTP ${initRes.status}`);
        }
        const { uploadUrl, accessToken, gcsUri, contentType } = await initRes.json();

        // Step 2: Upload file directly to GCS with access token (bypasses Cloud Run 32MB limit)
        const uploadRes = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            'Content-Type': contentType || file.type || 'application/octet-stream',
            'Authorization': `Bearer ${accessToken}`,
          },
          body: file,
        });
        if (!uploadRes.ok) {
          const errText = await uploadRes.text().catch(() => '');
          throw new Error(`GCS 上傳失敗: HTTP ${uploadRes.status} ${errText.slice(0, 200)}`);
        }

        // Step 3: Submit project with GCS URI
        const submitRes = await fetch(`${API}/api/projects/submit-gcs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            gcsUri,
            fileName: file.name,
            customDomain: customDomain.trim(),
            forceDomain,
            allowUnauthenticated: allowUnauth,
            envVars: envVarsText.trim() || undefined,
          }),
        });
        if (!submitRes.ok) {
          const data = await submitRes.json();
          if (data.error === 'domain_conflict') {
            setDomainConflict(data);
            setSubmitting(false);
            return;
          }
          throw new Error(data.error ?? data.message ?? `HTTP ${submitRes.status}`);
        }

        onSubmitted();
        return;
      }

      // For small files or git: use original multipart upload
      const formData = new FormData();
      formData.append('name', name.trim());
      formData.append('sourceType', sourceType);
      formData.append('customDomain', customDomain.trim());
      formData.append('forceDomain', String(forceDomain));
      formData.append('allowUnauthenticated', String(allowUnauth));
      if (envVarsText.trim()) {
        formData.append('envVars', envVarsText.trim());
      }
      if (sourceType === 'git') {
        formData.append('gitUrl', gitUrl.trim());
      } else if (file) {
        formData.append('file', file);
      }
      if (dbDumpFile) {
        formData.append('dbDump', dbDumpFile);
      }

      const res = await fetch(`${API}/api/projects/upload`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json();
        if (data.error === 'domain_conflict') {
          setDomainConflict(data);
          setSubmitting(false);
          return;
        }
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }

      onSubmitted();
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    if (!name.trim()) { setError('請輸入專案名稱'); return; }
    if (sourceType === 'upload' && !file) { setError('請上傳專案壓縮檔'); return; }
    if (sourceType === 'git' && !gitUrl.trim()) { setError('請輸入 Git URL'); return; }

    // Pre-flight: check custom domain for conflicts (if user set one)
    if (customDomain.trim()) {
      setSubmitting(true);
      setError(null);
      try {
        // Check both the main domain and the api.* variant (for monorepos)
        const subs = [customDomain.trim(), `api.${customDomain.trim()}`];
        for (const sub of subs) {
          const res = await fetch(`${API}/api/infra/check-domain?subdomain=${encodeURIComponent(sub)}&zone=punwave.com`);
          const data = await res.json();
          if (res.ok && data.available === false) {
            setDomainConflict({ fqdn: data.fqdn, existingRoute: data.existingRoute });
            setSubmitting(false);
            return;
          }
        }
      } catch (err) {
        console.warn('Domain pre-check failed:', err);
        // Don't block submission if pre-check fails — backend will enforce
      }
    }

    await doSubmit(false);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }} onClick={onClose}>
      <div style={{
        background: 'var(--bg-secondary)', borderRadius: 12, padding: 24,
        width: 520, maxWidth: '90vw', border: '1px solid var(--border)',
      }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>提交專案</h3>

        <ModalField label="專案名稱" value={name} onChange={setName} placeholder="my-awesome-app" />

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 4, color: 'var(--text-secondary)' }}>
            來源類型
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className={`btn ${sourceType === 'upload' ? 'btn-primary' : ''}`}
              onClick={() => setSourceType('upload')}
              style={{ flex: 1, fontSize: 13, padding: '8px 12px' }}
            >
              上傳壓縮檔
            </button>
            <button
              type="button"
              className={`btn ${sourceType === 'git' ? 'btn-primary' : ''}`}
              onClick={() => setSourceType('git')}
              style={{ flex: 1, fontSize: 13, padding: '8px 12px' }}
            >
              Git 儲存庫
            </button>
          </div>
        </div>

        {sourceType === 'upload' ? (
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 13, marginBottom: 4, color: 'var(--text-secondary)' }}>
              專案檔案
            </label>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const f = e.dataTransfer.files[0];
                if (f) handleFile(f);
              }}
              onClick={() => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.zip,.tar.gz,.tgz,.tar';
                input.onchange = () => {
                  const f = input.files?.[0];
                  if (f) handleFile(f);
                };
                input.click();
              }}
              style={{
                border: `2px dashed ${dragOver ? 'var(--accent)' : file ? 'var(--status-live)' : 'var(--border)'}`,
                borderRadius: 8,
                padding: file ? '16px' : '32px 16px',
                textAlign: 'center',
                cursor: 'pointer',
                background: dragOver ? 'rgba(88,166,255,0.05)' : 'var(--bg-primary)',
                transition: 'all 0.2s ease',
              }}
            >
              {file ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
                  <span style={{ fontSize: 20 }}>{'\uD83D\uDCC2'}</span>
                  <div style={{ textAlign: 'left' }}>
                    <div style={{ fontWeight: 500, fontSize: 14, color: 'var(--text-primary)' }}>{file.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      {(file.size / 1024 / 1024).toFixed(1)} MB — 點擊或拖曳以替換
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.5 }}>{'\uD83D\uDCC1'}</div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 4 }}>
                    拖曳專案壓縮檔到此處
                  </div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                    或點擊瀏覽 — 支援 .zip、.tar.gz、.tar（最大 100MB）
                  </div>
                </>
              )}
            </div>
          </div>
        ) : (
          <ModalField
            label="Git URL"
            value={gitUrl}
            onChange={setGitUrl}
            placeholder="https://github.com/owner/repo"
          />
        )}

        <ModalField
          label="自訂網域（選填）"
          value={customDomain}
          onChange={setCustomDomain}
          placeholder="my-app（將會變成 my-app.punwave.com）"
        />

        {/* allowUnauthenticated is always true — deploy agent projects are public by default */}

        {/* DB Dump upload (optional) */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 4, color: 'var(--text-secondary)' }}>
            資料庫 Dump（選填）
          </label>
          <div
            onClick={() => {
              const input = document.createElement('input');
              input.type = 'file';
              input.accept = '.sql,.dump,.pgdump,.sql.gz';
              input.onchange = () => {
                const f = input.files?.[0];
                if (f) setDbDumpFile(f);
              };
              input.click();
            }}
            style={{
              border: `1px solid ${dbDumpFile ? 'var(--status-live)' : 'var(--border)'}`,
              borderRadius: 6,
              padding: '8px 12px',
              cursor: 'pointer',
              background: 'var(--bg-primary)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
            }}
          >
            {dbDumpFile ? (
              <>
                <span style={{ fontSize: 16 }}>{'\uD83D\uDDC3\uFE0F'}</span>
                <div style={{ flex: 1 }}>
                  <span style={{ color: 'var(--text-primary)' }}>{dbDumpFile.name}</span>
                  <span style={{ color: 'var(--text-secondary)', marginLeft: 8 }}>
                    ({(dbDumpFile.size / 1024 / 1024).toFixed(1)} MB)
                  </span>
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setDbDumpFile(null); }}
                  style={{
                    background: 'none', border: 'none', color: 'var(--text-secondary)',
                    cursor: 'pointer', fontSize: 16, padding: '0 4px',
                  }}
                >
                  ✕
                </button>
              </>
            ) : (
              <span style={{ color: 'var(--text-secondary)' }}>
                點擊上傳 .sql、.dump 或 .sql.gz（部署時自動匯入資料庫）
              </span>
            )}
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <button
            type="button"
            className="btn"
            onClick={() => setShowEnvVars(!showEnvVars)}
            style={{ fontSize: 12, padding: '4px 10px', color: 'var(--text-secondary)' }}
          >
            {showEnvVars ? '- 隱藏環境變數' : '+ 環境變數（選填）'}
          </button>
          {showEnvVars && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
                每行一個，格式: KEY=VALUE（常見的如 NEXTAUTH_URL 會自動偵測設定）
              </div>
              <textarea
                value={envVarsText}
                onChange={(e) => setEnvVarsText(e.target.value)}
                placeholder={'DATABASE_URL=postgres://...\nAPI_KEY=sk-...'}
                rows={4}
                style={{
                  width: '100%', padding: '8px 12px',
                  background: 'var(--bg-primary)', border: '1px solid var(--border)',
                  borderRadius: 6, color: 'var(--text-primary)', fontSize: 13,
                  fontFamily: 'var(--font-mono)', resize: 'vertical',
                }}
              />
            </div>
          )}
        </div>

        {error && (
          <div style={{ padding: 8, marginBottom: 12, background: 'rgba(248,81,73,0.1)', borderRadius: 6, color: 'var(--status-critical)', fontSize: 13 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose} disabled={submitting}>取消</button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? '上傳掃描中...' : '提交掃描'}
          </button>
        </div>
      </div>

      {domainConflict && (
        <DomainConflictModal
          conflict={domainConflict}
          onCancel={() => setDomainConflict(null)}
          onConfirm={async () => {
            await doSubmit(true);
          }}
        />
      )}
    </div>
  );
}

function DomainConflictModal({
  conflict,
  onCancel,
  onConfirm,
}: {
  conflict: { fqdn: string; existingRoute: string };
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100,
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: 'var(--bg-secondary)', borderRadius: 12, padding: 24,
          width: 480, maxWidth: '90vw', border: '1px solid var(--status-warning, #d29922)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12, color: 'var(--status-warning, #d29922)' }}>
          ⚠ 網域已被佔用
        </h3>
        <p style={{ fontSize: 14, color: 'var(--text-primary)', marginBottom: 8, lineHeight: 1.6 }}>
          <code style={{ background: 'var(--bg-primary)', padding: '2px 6px', borderRadius: 4, fontSize: 13 }}>
            {conflict.fqdn}
          </code>
          {' '}目前被指向服務：
        </p>
        <p style={{ fontSize: 14, marginBottom: 12 }}>
          <code style={{ background: 'var(--bg-primary)', padding: '2px 6px', borderRadius: 4, fontSize: 13, color: 'var(--accent)' }}>
            {conflict.existingRoute}
          </code>
        </p>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20, lineHeight: 1.6 }}>
          強制覆蓋會把這個網域改指向新服務，
          <strong style={{ color: 'var(--status-critical)' }}>並會讓原本的服務失去這個網域</strong>。
          確定要繼續嗎？
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onCancel} disabled={busy}>取消</button>
          <button
            className="btn"
            style={{ background: 'var(--status-critical)', color: '#fff', borderColor: 'var(--status-critical)' }}
            onClick={async () => {
              setBusy(true);
              try { await onConfirm(); } finally { setBusy(false); }
            }}
            disabled={busy}
          >
            {busy ? '處理中...' : '強制覆蓋'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModalField({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder: string;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: 13, marginBottom: 4, color: 'var(--text-secondary)' }}>
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: '100%', padding: '8px 12px',
          background: 'var(--bg-primary)', border: '1px solid var(--border)',
          borderRadius: 6, color: 'var(--text-primary)', fontSize: 14,
        }}
      />
    </div>
  );
}

function DeleteModal({ project, deleting, deleteLog, onClose, onConfirm }: {
  project: Project;
  deleting: boolean;
  deleteLog: { step: string; status: string; error?: string }[] | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const done = deleteLog && deleteLog.length > 0 && !deleting;
  const allOk = done && deleteLog.every((l) => l.status === 'ok');

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }} onClick={onClose}>
      <div style={{
        background: 'var(--bg-secondary)', borderRadius: 12, padding: 24,
        width: 520, maxWidth: '90vw', border: '1px solid var(--border)',
      }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8, color: 'var(--status-critical)' }}>
          刪除專案
        </h3>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 16, fontSize: 14, lineHeight: 1.5 }}>
          確定要刪除 <strong style={{ color: 'var(--text-primary)' }}>{project.name}</strong>？
          這將會清除所有相關的 GCP 資源：
        </p>
        <ul style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16, paddingLeft: 20, lineHeight: 1.8 }}>
          <li>Cloud Run 服務</li>
          <li>網域對應與 SSL 憑證</li>
          <li>Cloudflare DNS 紀錄</li>
          <li>Artifact Registry 中的容器映像</li>
          <li>所有資料庫紀錄（掃描、審查、部署）</li>
        </ul>

        {/* Teardown progress log */}
        {(deleting || deleteLog) && (
          <div style={{
            background: 'var(--bg-primary)', borderRadius: 6, padding: 12,
            marginBottom: 16, maxHeight: 200, overflowY: 'auto', fontSize: 13,
            fontFamily: 'monospace', border: '1px solid var(--border)',
          }}>
            {deleting && !deleteLog && (
              <div style={{ color: 'var(--text-secondary)' }}>正在清除資源...</div>
            )}
            {deleteLog?.map((log, i) => (
              <div key={i} style={{ marginBottom: 4, display: 'flex', gap: 8 }}>
                <span>{log.status === 'ok' ? '\u2705' : '\u274c'}</span>
                <span style={{ color: log.status === 'ok' ? 'var(--status-live)' : 'var(--status-critical)' }}>
                  {log.step}
                  {log.error && <span style={{ color: 'var(--status-critical)', marginLeft: 8 }}>({log.error})</span>}
                </span>
              </div>
            ))}
            {allOk && (
              <div style={{ marginTop: 8, color: 'var(--status-live)', fontWeight: 500 }}>
                所有資源已成功清除。
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose} disabled={deleting}>取消</button>
          {!done && (
            <button
              className="btn"
              onClick={onConfirm}
              disabled={deleting}
              style={{
                background: 'var(--status-critical)', color: '#fff',
                borderColor: 'var(--status-critical)', opacity: deleting ? 0.6 : 1,
              }}
            >
              {deleting ? '刪除中...' : '刪除並清除資源'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function GroupCard({
  group, expanded, selected, actionBusy,
  onToggleExpand, onToggleSelect, onGroupAction, onServiceAction, onDeleteService,
}: {
  group: ProjectGroup;
  expanded: boolean;
  selected: Set<string>;
  actionBusy: string | null;
  onToggleExpand: () => void;
  onToggleSelect: (serviceId: string) => void;
  onGroupAction: (action: 'stop' | 'start') => void;
  onServiceAction: (projectId: string, action: 'stop' | 'start') => void;
  onDeleteService: (svc: ProjectWithResources) => void;
}) {
  const busyStop = actionBusy === `${group.groupId}:stop`;
  const busyStart = actionBusy === `${group.groupId}:start`;
  const selectedLabel = selected.size > 0 ? `(${selected.size} 個選中)` : '(全部)';
  const isMonorepo = group.serviceCount > 1;

  return (
    <div style={{
      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
      borderRadius: 8, overflow: 'hidden',
    }}>
      {/* Group header */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
          cursor: 'pointer', userSelect: 'none' as const,
        }}
        onClick={onToggleExpand}
      >
        <span style={{ fontSize: 12, color: 'var(--text-secondary)', width: 12 }}>
          {expanded ? '▾' : '▸'}
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>
            {group.groupName}
            {isMonorepo && (
              <span style={{
                marginLeft: 8, fontSize: 11, padding: '2px 6px', borderRadius: 4,
                background: 'var(--bg-tertiary)', color: 'var(--text-secondary)',
                fontWeight: 400,
              }}>monorepo · {group.serviceCount} 個服務</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
            {group.liveCount > 0 && <span style={{ color: 'var(--status-live)' }}>● {group.liveCount} live </span>}
            {group.stoppedCount > 0 && <span style={{ color: 'var(--text-secondary)' }}>● {group.stoppedCount} stopped </span>}
            {group.failedCount > 0 && <span style={{ color: 'var(--status-critical)' }}>● {group.failedCount} failed </span>}
            <span style={{ marginLeft: 8 }}>更新於 {new Date(group.updatedAt).toLocaleString()}</span>
          </div>
        </div>
        {isMonorepo && (
          <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
            <button
              className="btn"
              disabled={busyStop}
              onClick={() => onGroupAction('stop')}
              style={{ fontSize: 12, padding: '4px 10px' }}
              title={`停止 ${selectedLabel}`}
            >
              {busyStop ? '停止中…' : `停止 ${selectedLabel}`}
            </button>
            <button
              className="btn"
              disabled={busyStart}
              onClick={() => onGroupAction('start')}
              style={{ fontSize: 12, padding: '4px 10px', color: 'var(--status-live)', borderColor: 'var(--status-live)' }}
              title={`啟動 ${selectedLabel}`}
            >
              {busyStart ? '啟動中…' : `啟動 ${selectedLabel}`}
            </button>
          </div>
        )}
      </div>

      {/* Expanded services */}
      {expanded && (
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {group.services.map((svc) => (
            <ServiceRow
              key={svc.id}
              svc={svc}
              isMonorepo={isMonorepo}
              checked={selected.has(svc.id)}
              actionBusy={actionBusy}
              onToggleSelect={() => onToggleSelect(svc.id)}
              onServiceAction={onServiceAction}
              onDeleteService={() => onDeleteService(svc)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ServiceRow({
  svc, isMonorepo, checked, actionBusy, onToggleSelect, onServiceAction, onDeleteService,
}: {
  svc: ProjectWithResources;
  isMonorepo: boolean;
  checked: boolean;
  actionBusy: string | null;
  onToggleSelect: () => void;
  onServiceAction: (projectId: string, action: 'stop' | 'start') => void;
  onDeleteService: () => void;
}) {
  const running = svc.status === 'live';
  const stopped = svc.status === 'stopped';
  const canStop = running;
  const canStart = stopped;
  const busyStop = actionBusy === `svc:${svc.id}:stop`;
  const busyStart = actionBusy === `svc:${svc.id}:start`;
  const url = svc.latestDeployment?.cloudRunUrl || (svc.latestDeployment?.customDomain ? `https://${svc.latestDeployment.customDomain}` : null);
  const gcsSource = svc.resources.find((r) => r.kind === 'gcs_source');

  return (
    <div style={{
      padding: '12px 16px 12px 40px', borderTop: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {isMonorepo && (
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggleSelect}
            style={{ cursor: 'pointer' }}
          />
        )}
        <a href={`/projects/${svc.id}`} style={{ fontWeight: 500, color: 'var(--text-primary)', textDecoration: 'none' }}>
          {svc.name}
        </a>
        <StatusPill status={svc.status} />
        {svc.detectedLanguage && (
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{svc.detectedLanguage}{svc.detectedFramework ? ` · ${svc.detectedFramework}` : ''}</span>
        )}
        {url && (
          <a href={url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: 'var(--accent-blue, #58a6ff)', fontFamily: 'monospace', marginLeft: 'auto' }}>
            {url.replace(/^https?:\/\//, '')} ↗
          </a>
        )}
      </div>

      {/* Resources list */}
      {svc.resources.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginLeft: isMonorepo ? 24 : 0 }}>
          {svc.resources.map((r, i) => (
            <span key={i} style={{
              fontSize: 11, padding: '3px 8px', borderRadius: 4,
              background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
              color: 'var(--text-secondary)', fontFamily: 'monospace',
            }} title={r.detail}>
              <span style={{ color: 'var(--text-primary)' }}>{resourceIcon(r.kind)}</span> {r.label}
            </span>
          ))}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6, marginLeft: isMonorepo ? 24 : 0 }}>
        {canStop && (
          <button
            className="btn"
            disabled={busyStop}
            onClick={() => onServiceAction(svc.id, 'stop')}
            style={{ fontSize: 11, padding: '3px 10px' }}
          >{busyStop ? '停止中…' : '停止'}</button>
        )}
        {canStart && (
          <button
            className="btn"
            disabled={busyStart}
            onClick={() => onServiceAction(svc.id, 'start')}
            style={{ fontSize: 11, padding: '3px 10px', color: 'var(--status-live)', borderColor: 'var(--status-live)' }}
          >{busyStart ? '啟動中…' : '啟動'}</button>
        )}
        {gcsSource && (
          <a
            href={`${API}/api/projects/${svc.id}/source-download`}
            className="btn"
            style={{ fontSize: 11, padding: '3px 10px', textDecoration: 'none' }}
          >下載原始碼</a>
        )}
        <button
          className="btn"
          onClick={onDeleteService}
          style={{ fontSize: 11, padding: '3px 10px', color: 'var(--status-critical)', borderColor: 'var(--status-critical)', marginLeft: 'auto' }}
        >刪除</button>
      </div>
    </div>
  );
}

function resourceIcon(kind: ProjectResource['kind']): string {
  switch (kind) {
    case 'cloud_run': return '☁️';
    case 'custom_domain': return '🌐';
    case 'redis_db': return '🔴';
    case 'postgres_db': return '🐘';
    case 'gcs_source': return '📦';
    default: return '•';
  }
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    submitted: 'pill-scanning',
    scanning: 'pill-scanning',
    review_pending: 'pill-review',
    approved: 'pill-live',
    deploying: 'pill-deploying',
    deployed: 'pill-deploying',
    ssl_provisioning: 'pill-deploying',
    canary_check: 'pill-deploying',
    live: 'pill-live',
    failed: 'pill-failed',
    rejected: 'pill-failed',
    needs_revision: 'pill-review',
    rolling_back: 'pill-failed',
    stopped: 'pill-failed',
  };
  return <span className={`pill ${map[status] ?? ''}`}>{status.replace(/_/g, ' ')}</span>;
}
