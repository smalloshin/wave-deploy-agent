'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

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
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  const t = useTranslations('projects');
  const tc = useTranslations('common');

  const loadGroups = (silent = false) => {
    if (!silent) setLoading(true);
    fetch(`${API}/api/project-groups`, { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => { setGroups(data.groups ?? []); setLoading(false); })
      .catch((err) => { setError(err.message); setLoading(false); });
  };

  const loadProjects = loadGroups;

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
    const targetCount = serviceIds ? serviceIds.length : group.serviceCount;
    const actionLabel = action === 'stop' ? tc('stop') : tc('start');
    if (!window.confirm(`${actionLabel} ${targetCount} 個服務？`)) return;
    const key = `${group.groupId}:${action}`;
    setActionBusy(key);
    try {
      const res = await fetch(`${API}/api/project-groups/${group.groupId}/actions`, { credentials: 'include', method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, serviceIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const failed = (data.results ?? []).filter((r: { success: boolean }) => !r.success);
      if (failed.length > 0) {
        alert(t('failedCount', { failed: String(failed.length), total: String((data.results ?? []).length) }) + '\n' +
          failed.map((r: { name: string; message: string }) => `- ${r.name}: ${r.message}`).join('\n'));
      }
      loadGroups(true);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setActionBusy(null);
    }
  };

  const retryService = async (projectId: string) => {
    const key = `svc:${projectId}:retry`;
    setActionBusy(key);
    try {
      const res = await fetch(`${API}/api/projects/${projectId}/resubmit`, { credentials: 'include', method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
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
      const res = await fetch(`${API}/api/projects/${projectId}/${action}`, { credentials: 'include', method: 'POST' });
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
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      loadGroups(true);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div>
        <Header t={t} onSubmit={() => setShowModal(true)} />
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
        <Header t={t} onSubmit={() => setShowModal(true)} />
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
          <p>{t('loadFailed')} <button className="btn btn-sm" onClick={() => window.location.reload()}>{tc('retry')}</button></p>
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
      <Header t={t} onSubmit={() => setShowModal(true)} />
      {groups.length === 0 ? (
        <div style={{
          marginTop: 'var(--sp-7)',
          textAlign: 'center',
          color: 'var(--ink-500)',
          padding: 'var(--sp-7) var(--sp-5)',
          background: 'var(--surface-1)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-lg)',
        }}>
          <p style={{ fontSize: 'var(--fs-lg)', color: 'var(--ink-900)', fontWeight: 600, marginBottom: 'var(--sp-2)' }}>{t('noProjects')}</p>
          <p style={{ fontSize: 'var(--fs-md)' }}>{t('noProjectsDesc')}</p>
          <button className="btn btn-primary" style={{ marginTop: 'var(--sp-4)' }} onClick={() => setShowModal(true)}>
            {t('submitProject')}
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
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
              onRetryService={retryService}
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
              const res = await fetch(`${API}/api/projects/${deleteTarget.id}`, { credentials: 'include', method: 'DELETE' });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
              setDeleteLog(data.teardownLog ?? []);
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

function Header({ t, onSubmit }: { t: (key: string) => string; onSubmit: () => void }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 'var(--sp-5)',
    }}>
      <h2 style={{
        fontSize: 'var(--fs-2xl)',
        fontWeight: 700,
        letterSpacing: '-0.02em',
        lineHeight: 'var(--lh-tight)',
        color: 'var(--ink-900)',
      }}>{t('title')}</h2>
      <button className="btn btn-primary" onClick={onSubmit}>
        {t('submitProject')}
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
  const [allowUnauth] = useState(true);
  const [envVarsText, setEnvVarsText] = useState('');
  const [dbDumpFile, setDbDumpFile] = useState<File | null>(null);
  const [showEnvVars, setShowEnvVars] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [domainConflict, setDomainConflict] = useState<{ fqdn: string; existingRoute: string } | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);

  const t = useTranslations('projects.submitModal');
  const td = useTranslations('projects.domainConflict');
  const tc = useTranslations('common');

  const handleFile = (f: File) => {
    const validTypes = ['.zip', '.tar.gz', '.tgz', '.tar'];
    const isValid = validTypes.some((ext) => f.name.toLowerCase().endsWith(ext));
    if (!isValid) {
      setError(t('invalidFileType'));
      return;
    }
    setFile(f);
    setError(null);
    if (!name.trim()) {
      const baseName = f.name.replace(/\.(zip|tar\.gz|tgz|tar)$/i, '');
      setName(baseName);
    }
  };

  const GCS_UPLOAD_THRESHOLD = 30 * 1024 * 1024;

  const doSubmit = async (forceDomain: boolean) => {
    setSubmitting(true);
    setError(null);
    setDomainConflict(null);

    try {
      if (sourceType === 'upload' && file && file.size > GCS_UPLOAD_THRESHOLD) {
        setError(null);

        const initRes = await fetch(`${API}/api/upload/init`, { credentials: 'include', method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: file.name,
            fileSize: file.size,
            contentType: file.type || 'application/octet-stream',
          }),
        });
        if (!initRes.ok) {
          const data = await initRes.json();
          throw new Error(data.error ?? `Init failed: HTTP ${initRes.status}`);
        }
        const { uploadUrl, gcsUri, contentType } = await initRes.json();

        // PUT directly to GCS resumable session URI. No Authorization header
        // (auth embedded in URI) → no CORS preflight, no token expiry mid-upload.
        // Use XHR for upload progress events (fetch doesn't expose them).
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', uploadUrl);
          xhr.setRequestHeader('Content-Type', contentType || file.type || 'application/octet-stream');
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const pct = Math.round((e.loaded / e.total) * 100);
              setUploadProgress(pct);
            }
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else reject(new Error(t('gcsUploadFailed', { status: String(xhr.status), detail: xhr.responseText.slice(0, 200) })));
          };
          xhr.onerror = () => reject(new Error(t('gcsUploadFailed', { status: 'network', detail: 'connection failed' })));
          xhr.ontimeout = () => reject(new Error(t('gcsUploadFailed', { status: 'timeout', detail: 'upload timed out' })));
          xhr.send(file);
        });
        setUploadProgress(null);

        const submitRes = await fetch(`${API}/api/projects/submit-gcs`, { credentials: 'include', method: 'POST',
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

      const res = await fetch(`${API}/api/projects/upload`, { credentials: 'include', method: 'POST',
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
      setUploadProgress(null);
    }
  };

  const handleSubmit = async () => {
    if (!name.trim()) { setError(t('errorProjectName')); return; }
    if (sourceType === 'upload' && !file) { setError(t('errorUploadFile')); return; }
    if (sourceType === 'git' && !gitUrl.trim()) { setError(t('errorGitUrl')); return; }
    if (!customDomain.trim()) { setError(t('errorCustomDomain')); return; }

    if (customDomain.trim()) {
      setSubmitting(true);
      setError(null);
      try {
        const subs = [customDomain.trim(), `api.${customDomain.trim()}`];
        for (const sub of subs) {
          const res = await fetch(`${API}/api/infra/check-domain?subdomain=${encodeURIComponent(sub)}&zone=punwave.com`, { credentials: 'include' });
          const data = await res.json();
          if (res.ok && data.available === false) {
            setDomainConflict({ fqdn: data.fqdn, existingRoute: data.existingRoute });
            setSubmitting(false);
            return;
          }
        }
      } catch (err) {
        console.warn('Domain pre-check failed:', err);
      }
    }

    await doSubmit(false);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(11,14,20,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }} onClick={onClose}>
      <div style={{
        background: 'var(--surface-1)', borderRadius: 'var(--r-lg)', padding: 'var(--sp-6)',
        width: 560, maxWidth: '90vw', border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-md)',
      }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{
          fontSize: 'var(--fs-lg)', fontWeight: 600, marginBottom: 'var(--sp-4)',
          color: 'var(--ink-900)', letterSpacing: '-0.01em',
        }}>{t('title')}</h3>

        <ModalField label={t('projectName')} value={name} onChange={setName} placeholder="my-awesome-app" />

        <div style={{ marginBottom: 'var(--sp-3)' }}>
          <label style={{ display: 'block', fontSize: 'var(--fs-sm)', fontWeight: 500, marginBottom: 6, color: 'var(--ink-700)' }}>
            {t('sourceType')}
          </label>
          <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
            <button
              type="button"
              className={`btn btn-sm ${sourceType === 'upload' ? 'btn-primary' : ''}`}
              onClick={() => setSourceType('upload')}
              style={{ flex: 1, justifyContent: 'center' }}
            >
              {t('uploadArchive')}
            </button>
            <button
              type="button"
              className={`btn btn-sm ${sourceType === 'git' ? 'btn-primary' : ''}`}
              onClick={() => setSourceType('git')}
              style={{ flex: 1, justifyContent: 'center' }}
            >
              {t('gitRepo')}
            </button>
          </div>
        </div>

        {sourceType === 'upload' ? (
          <div style={{ marginBottom: 'var(--sp-3)' }}>
            <label style={{ display: 'block', fontSize: 'var(--fs-sm)', fontWeight: 500, marginBottom: 6, color: 'var(--ink-700)' }}>
              {t('projectFiles')}
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
                border: `2px dashed ${dragOver ? 'var(--sea-500)' : file ? 'var(--ok)' : 'var(--border)'}`,
                borderRadius: 'var(--r-md)',
                padding: file ? 'var(--sp-4)' : 'var(--sp-6) var(--sp-4)',
                textAlign: 'center',
                cursor: 'pointer',
                background: dragOver ? 'var(--sea-50)' : 'var(--ink-50)',
                transition: 'all 0.2s ease',
              }}
            >
              {file ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
                  <span style={{ fontSize: 20 }}>{'\uD83D\uDCC2'}</span>
                  <div style={{ textAlign: 'left' }}>
                    <div style={{ fontWeight: 600, fontSize: 'var(--fs-md)', color: 'var(--ink-900)' }}>{file.name}</div>
                    <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-500)' }}>
                      {t('replaceHint', { size: (file.size / 1024 / 1024).toFixed(1) })}
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.5 }}>{'\uD83D\uDCC1'}</div>
                  <div style={{ color: 'var(--ink-700)', fontSize: 'var(--fs-md)', marginBottom: 4 }}>
                    {t('dragHint')}
                  </div>
                  <div style={{ color: 'var(--ink-500)', fontSize: 'var(--fs-xs)' }}>
                    {t('browseHint')}
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
          label={t('customDomain')}
          value={customDomain}
          onChange={setCustomDomain}
          placeholder={t('customDomainPlaceholder')}
        />

        {/* DB Dump upload (optional) */}
        <div style={{ marginBottom: 'var(--sp-3)' }}>
          <label style={{ display: 'block', fontSize: 'var(--fs-sm)', fontWeight: 500, marginBottom: 6, color: 'var(--ink-700)' }}>
            {t('dbDump')}
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
              border: `1px solid ${dbDumpFile ? 'var(--ok)' : 'var(--border)'}`,
              borderRadius: 'var(--r-md)',
              padding: '10px var(--sp-3)',
              cursor: 'pointer',
              background: 'var(--ink-50)',
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--sp-2)',
              fontSize: 'var(--fs-sm)',
            }}
          >
            {dbDumpFile ? (
              <>
                <span style={{ fontSize: 16 }}>{'\uD83D\uDDC3\uFE0F'}</span>
                <div style={{ flex: 1 }}>
                  <span style={{ color: 'var(--ink-900)', fontWeight: 500 }}>{dbDumpFile.name}</span>
                  <span style={{ color: 'var(--ink-500)', marginLeft: 8 }}>
                    ({(dbDumpFile.size / 1024 / 1024).toFixed(1)} MB)
                  </span>
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setDbDumpFile(null); }}
                  style={{
                    background: 'none', border: 'none', color: 'var(--ink-500)',
                    cursor: 'pointer', fontSize: 16, padding: '0 4px',
                  }}
                >
                  ✕
                </button>
              </>
            ) : (
              <span style={{ color: 'var(--ink-500)' }}>
                {t('dbDumpHint')}
              </span>
            )}
          </div>
        </div>

        <div style={{ marginBottom: 'var(--sp-4)' }}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setShowEnvVars(!showEnvVars)}
            style={{ color: 'var(--ink-500)' }}
          >
            {showEnvVars ? t('hideEnvVars') : t('showEnvVars')}
          </button>
          {showEnvVars && (
            <div style={{ marginTop: 'var(--sp-2)' }}>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-500)', marginBottom: 6 }}>
                {t('envVarsHint')}
              </div>
              <textarea
                value={envVarsText}
                onChange={(e) => setEnvVarsText(e.target.value)}
                placeholder={'DATABASE_URL=postgres://...\nAPI_KEY=sk-...'}
                rows={4}
                style={{
                  width: '100%', padding: '10px var(--sp-3)',
                  background: 'var(--surface-1)', border: '1px solid var(--border)',
                  borderRadius: 'var(--r-md)', color: 'var(--ink-900)', fontSize: 'var(--fs-sm)',
                  fontFamily: 'var(--font-mono)', resize: 'vertical',
                }}
              />
            </div>
          )}
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

        {uploadProgress !== null && (
          <div style={{
            padding: 'var(--sp-3)',
            marginBottom: 'var(--sp-3)',
            background: 'var(--info-bg)',
            border: '1px solid var(--info)',
            borderRadius: 'var(--r-md)',
            fontSize: 'var(--fs-sm)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, color: 'var(--info)' }}>
              <span>上傳到 GCS</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono, monospace)' }}>{uploadProgress}%</span>
            </div>
            <div style={{ height: 6, background: 'var(--ink-100)', borderRadius: 'var(--r-pill)', overflow: 'hidden' }}>
              <div style={{
                width: `${uploadProgress}%`,
                height: '100%',
                background: 'var(--info)',
                transition: 'width 200ms ease',
              }} />
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose} disabled={submitting}>{tc('cancel')}</button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? t('submitting') : t('submitScan')}
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
  const t = useTranslations('projects.domainConflict');
  const tc = useTranslations('common');

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(11,14,20,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100,
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: 'var(--surface-1)', borderRadius: 'var(--r-lg)', padding: 'var(--sp-6)',
          width: 520, maxWidth: '90vw', border: '1px solid var(--warn)',
          boxShadow: 'var(--shadow-md)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{
          fontSize: 'var(--fs-lg)', fontWeight: 600, marginBottom: 'var(--sp-3)',
          color: 'var(--warn)', letterSpacing: '-0.01em',
        }}>
          {t('title')}
        </h3>
        <p style={{ fontSize: 'var(--fs-md)', color: 'var(--ink-900)', marginBottom: 'var(--sp-2)', lineHeight: 'var(--lh-normal)' }}>
          <code style={{
            background: 'var(--ink-50)', padding: '2px 6px', borderRadius: 'var(--r-sm)',
            fontFamily: 'var(--font-mono, monospace)', fontSize: 'var(--fs-sm)', color: 'var(--ink-900)',
          }}>
            {conflict.fqdn}
          </code>
          {' '}{t('currentlyPointsTo')}
        </p>
        <p style={{ fontSize: 'var(--fs-md)', marginBottom: 'var(--sp-3)' }}>
          <code style={{
            background: 'var(--sea-50)', padding: '2px 6px', borderRadius: 'var(--r-sm)',
            fontFamily: 'var(--font-mono, monospace)', fontSize: 'var(--fs-sm)', color: 'var(--sea-700)',
          }}>
            {conflict.existingRoute}
          </code>
        </p>
        <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-500)', marginBottom: 'var(--sp-5)', lineHeight: 'var(--lh-normal)' }}>
          {t('forceOverrideWarning')}
          <strong style={{ color: 'var(--danger)' }}>{t('loseWarning')}</strong>。
          {t('confirmQuestion')}
        </p>
        <div style={{ display: 'flex', gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onCancel} disabled={busy}>{tc('cancel')}</button>
          <button
            className="btn btn-danger"
            onClick={async () => {
              setBusy(true);
              try { await onConfirm(); } finally { setBusy(false); }
            }}
            disabled={busy}
          >
            {busy ? tc('processing') : t('forceOverride')}
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
    <div style={{ marginBottom: 'var(--sp-3)' }}>
      <label style={{
        display: 'block', fontSize: 'var(--fs-sm)', fontWeight: 500,
        marginBottom: 6, color: 'var(--ink-700)',
      }}>
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: '100%', padding: '10px var(--sp-3)',
          background: 'var(--surface-1)', border: '1px solid var(--border)',
          borderRadius: 'var(--r-md)', color: 'var(--ink-900)', fontSize: 'var(--fs-md)',
          fontFamily: 'inherit', outline: 'none',
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
  const t = useTranslations('projects.deleteModal');
  const tc = useTranslations('common');

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(11,14,20,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }} onClick={onClose}>
      <div style={{
        background: 'var(--surface-1)', borderRadius: 'var(--r-lg)', padding: 'var(--sp-6)',
        width: 560, maxWidth: '90vw', border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-md)',
      }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{
          fontSize: 'var(--fs-lg)', fontWeight: 600, marginBottom: 'var(--sp-2)',
          color: 'var(--danger)', letterSpacing: '-0.01em',
        }}>
          {t('title')}
        </h3>
        <p style={{ color: 'var(--ink-700)', marginBottom: 'var(--sp-4)', fontSize: 'var(--fs-md)', lineHeight: 'var(--lh-normal)' }}>
          {t('confirmMessage', { name: project.name })}
          {' '}{t('resourceWarning')}
        </p>
        <ul style={{ color: 'var(--ink-500)', fontSize: 'var(--fs-sm)', marginBottom: 'var(--sp-4)', paddingLeft: 20, lineHeight: 1.8 }}>
          <li>{t('cloudRunService')}</li>
          <li>{t('domainAndSsl')}</li>
          <li>{t('cloudflareDns')}</li>
          <li>{t('containerImages')}</li>
          <li>{t('allDbRecords')}</li>
        </ul>

        {/* Teardown progress log */}
        {(deleting || deleteLog) && (
          <div style={{
            background: 'var(--ink-50)', borderRadius: 'var(--r-md)', padding: 'var(--sp-3)',
            marginBottom: 'var(--sp-4)', maxHeight: 200, overflowY: 'auto', fontSize: 'var(--fs-sm)',
            fontFamily: 'var(--font-mono, monospace)', border: '1px solid var(--ink-100)',
          }}>
            {deleting && !deleteLog && (
              <div style={{ color: 'var(--ink-500)' }}>{t('cleaningResources')}</div>
            )}
            {deleteLog?.map((log, i) => (
              <div key={i} style={{ marginBottom: 4, display: 'flex', gap: 8 }}>
                <span>{log.status === 'ok' ? '\u2705' : '\u274c'}</span>
                <span style={{ color: log.status === 'ok' ? 'var(--ok)' : 'var(--danger)' }}>
                  {log.step}
                  {log.error && <span style={{ color: 'var(--danger)', marginLeft: 8 }}>({log.error})</span>}
                </span>
              </div>
            ))}
            {allOk && (
              <div style={{ marginTop: 8, color: 'var(--ok)', fontWeight: 600 }}>
                {t('allResourcesCleaned')}
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose} disabled={deleting}>{tc('cancel')}</button>
          {!done && (
            <button
              className="btn btn-danger"
              onClick={onConfirm}
              disabled={deleting}
              style={{ opacity: deleting ? 0.6 : 1 }}
            >
              {deleting ? t('deleting') : t('deleteAndClean')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function GroupCard({
  group, expanded, selected, actionBusy,
  onToggleExpand, onToggleSelect, onGroupAction, onServiceAction, onRetryService, onDeleteService,
}: {
  group: ProjectGroup;
  expanded: boolean;
  selected: Set<string>;
  actionBusy: string | null;
  onToggleExpand: () => void;
  onToggleSelect: (serviceId: string) => void;
  onGroupAction: (action: 'stop' | 'start') => void;
  onServiceAction: (projectId: string, action: 'stop' | 'start') => void;
  onRetryService: (projectId: string) => void;
  onDeleteService: (svc: ProjectWithResources) => void;
}) {
  const busyStop = actionBusy === `${group.groupId}:stop`;
  const busyStart = actionBusy === `${group.groupId}:start`;
  const t = useTranslations('projects');
  const tc = useTranslations('common');
  const selectedLabel = selected.size > 0 ? t('selected', { count: String(selected.size) }) : t('all');
  const isMonorepo = group.serviceCount > 1;

  return (
    <div style={{
      background: 'var(--surface-1)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      overflow: 'hidden',
    }}>
      {/* Group header */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 'var(--sp-3)',
          padding: 'var(--sp-4) var(--sp-5)',
          cursor: 'pointer', userSelect: 'none' as const,
        }}
        onClick={onToggleExpand}
      >
        <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-400)', width: 14 }}>
          {expanded ? '\u25BE' : '\u25B8'}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 'var(--fs-lg)', letterSpacing: '-0.01em', color: 'var(--ink-900)' }}>
            {!isMonorepo && group.services.length === 1 ? (
              <a href={`/projects/${group.services[0].id}`} style={{ color: 'var(--ink-900)', textDecoration: 'none' }}
                onClick={(e) => e.stopPropagation()}>
                {group.groupName}
              </a>
            ) : (
              group.groupName
            )}
            {isMonorepo && (
              <span style={{
                marginLeft: 'var(--sp-2)',
                fontSize: 'var(--fs-xs)',
                padding: '2px var(--sp-2)',
                borderRadius: 'var(--r-sm)',
                background: 'var(--ink-100)',
                color: 'var(--ink-500)',
                fontWeight: 500,
                verticalAlign: 'middle',
              }}>{t('monorepoServices', { count: String(group.serviceCount) })}</span>
            )}
          </div>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-500)', marginTop: 4, display: 'flex', gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
            {group.liveCount > 0 && <span style={{ color: 'var(--ok)' }}>{'\u25CF'} {group.liveCount} live</span>}
            {group.stoppedCount > 0 && <span>{'\u25CF'} {group.stoppedCount} stopped</span>}
            {group.failedCount > 0 && <span style={{ color: 'var(--danger)' }}>{'\u25CF'} {group.failedCount} failed</span>}
            <span>{t('updatedAt', { time: new Date(group.updatedAt).toLocaleString() })}</span>
          </div>
        </div>
        {isMonorepo && (
          <div style={{ display: 'flex', gap: 'var(--sp-2)' }} onClick={(e) => e.stopPropagation()}>
            <button
              className="btn btn-sm"
              disabled={busyStop}
              onClick={() => onGroupAction('stop')}
              title={`${tc('stop')} ${selectedLabel}`}
            >
              {busyStop ? tc('stopping') : `${tc('stop')} ${selectedLabel}`}
            </button>
            <button
              className="btn btn-sm"
              disabled={busyStart}
              onClick={() => onGroupAction('start')}
              style={{ color: 'var(--ok)', borderColor: 'var(--ok)' }}
              title={`${tc('start')} ${selectedLabel}`}
            >
              {busyStart ? tc('starting') : `${tc('start')} ${selectedLabel}`}
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
              onRetryService={onRetryService}
              onDeleteService={() => onDeleteService(svc)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ServiceRow({
  svc, isMonorepo, checked, actionBusy, onToggleSelect, onServiceAction, onRetryService, onDeleteService,
}: {
  svc: ProjectWithResources;
  isMonorepo: boolean;
  checked: boolean;
  actionBusy: string | null;
  onToggleSelect: () => void;
  onServiceAction: (projectId: string, action: 'stop' | 'start') => void;
  onRetryService: (projectId: string) => void;
  onDeleteService: () => void;
}) {
  const running = svc.status === 'live';
  const stopped = svc.status === 'stopped';
  const failed = svc.status === 'failed' || svc.status === 'needs_revision';
  const canStop = running;
  const canStart = stopped;
  const busyStop = actionBusy === `svc:${svc.id}:stop`;
  const busyStart = actionBusy === `svc:${svc.id}:start`;
  const busyRetry = actionBusy === `svc:${svc.id}:retry`;
  const url = svc.latestDeployment?.cloudRunUrl || (svc.latestDeployment?.customDomain ? `https://${svc.latestDeployment.customDomain}` : null);
  const gcsSource = svc.resources.find((r) => r.kind === 'gcs_source');
  const tc = useTranslations('common');

  return (
    <div style={{
      padding: 'var(--sp-4) var(--sp-5) var(--sp-4) var(--sp-7)',
      borderTop: '1px solid var(--ink-100)',
      display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
        {isMonorepo && (
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggleSelect}
            style={{ cursor: 'pointer' }}
          />
        )}
        <a href={`/projects/${svc.id}`} style={{
          fontWeight: 600,
          fontSize: 'var(--fs-md)',
          color: 'var(--ink-900)',
          textDecoration: 'none',
        }}>
          {svc.name}
        </a>
        <StatusPill status={svc.status} />
        {svc.detectedLanguage && (
          <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-500)' }}>{svc.detectedLanguage}{svc.detectedFramework ? ` \u00B7 ${svc.detectedFramework}` : ''}</span>
        )}
        {url && (
          <a href={url} target="_blank" rel="noreferrer" style={{
            fontSize: 'var(--fs-sm)',
            color: 'var(--sea-500)',
            fontFamily: 'var(--font-mono, monospace)',
            marginLeft: 'auto',
          }}>
            {url.replace(/^https?:\/\//, '')} ↗
          </a>
        )}
      </div>

      {/* Resources list */}
      {svc.resources.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)', marginLeft: isMonorepo ? 'var(--sp-5)' : 0 }}>
          {svc.resources.map((r, i) => (
            <span key={i} style={{
              fontSize: 'var(--fs-xs)',
              padding: '4px var(--sp-2)',
              borderRadius: 'var(--r-sm)',
              background: 'var(--ink-50)',
              border: '1px solid var(--ink-100)',
              color: 'var(--ink-500)',
              fontFamily: 'var(--font-mono, monospace)',
            }} title={r.detail}>
              <span style={{ color: 'var(--ink-900)' }}>{resourceIcon(r.kind)}</span> {r.label}
            </span>
          ))}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 'var(--sp-2)', marginLeft: isMonorepo ? 'var(--sp-5)' : 0, flexWrap: 'wrap' }}>
        {canStop && (
          <button
            className="btn btn-sm"
            disabled={busyStop}
            onClick={() => onServiceAction(svc.id, 'stop')}
          >{busyStop ? tc('stopping') : tc('stop')}</button>
        )}
        {canStart && (
          <button
            className="btn btn-sm"
            disabled={busyStart}
            onClick={() => onServiceAction(svc.id, 'start')}
            style={{ color: 'var(--ok)', borderColor: 'var(--ok)' }}
          >{busyStart ? tc('starting') : tc('start')}</button>
        )}
        {failed && (
          <button
            className="btn btn-sm"
            disabled={busyRetry}
            onClick={() => onRetryService(svc.id)}
            style={{ color: 'var(--sea-500)', borderColor: 'var(--sea-500)' }}
          >{busyRetry ? tc('retrying') : tc('retryPipeline')}</button>
        )}
        {gcsSource && (
          <a
            href={`${API}/api/projects/${svc.id}/source-download`}
            className="btn btn-sm"
            style={{ textDecoration: 'none' }}
          >{tc('downloadSourceCode')}</a>
        )}
        <button
          className="btn btn-sm btn-delete"
          onClick={onDeleteService}
          style={{ color: 'var(--danger)', borderColor: 'var(--danger)', marginLeft: 'auto' }}
        >{tc('delete')}</button>
      </div>
    </div>
  );
}

function resourceIcon(kind: ProjectResource['kind']): string {
  switch (kind) {
    case 'cloud_run': return '\u2601\uFE0F';
    case 'custom_domain': return '\uD83C\uDF10';
    case 'redis_db': return '\uD83D\uDD34';
    case 'postgres_db': return '\uD83D\uDC18';
    case 'gcs_source': return '\uD83D\uDCE6';
    default: return '\u2022';
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
