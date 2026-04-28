'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '../../../lib/auth';
import type { UploadErrorEnvelope, UploadFailure } from '@deploy-agent/shared';
import { mapEnvelope, mapClientError, fetchDiagnostic } from '@/lib/upload-error-mapper';
import { uploadResumable } from '@/lib/resumable-upload';
import { UploadErrorBlock } from '@/app/components/UploadErrorBlock';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

interface Project {
  id: string;
  name: string;
  slug: string;
  status: string;
  sourceType: string;
  sourceUrl: string | null;
  detectedLanguage: string | null;
  detectedFramework: string | null;
  config: {
    deployTarget?: string;
    customDomain?: string;
    allowUnauthenticated?: boolean;
    gcpProject?: string;
    gcpRegion?: string;
    envVars?: Record<string, string>;
    domainError?: string;
    domainErrorAt?: string;
  };
  createdAt: string;
  updatedAt: string;
}

interface TimelineEntry {
  id: number;
  fromState: string | null;
  toState: string;
  triggeredBy: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface ScanFinding {
  id: string;
  tool: string;
  category: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  description: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  action: 'auto_fix' | 'report_only';
}

interface AutoFixRecord {
  findingId?: string;
  filePath?: string;
  originalCode?: string;
  fixedCode?: string;
  explanation: string;
  applied?: boolean;
  diff?: string;
}

interface ScanReport {
  id: string;
  projectId: string;
  version: number;
  findings: ScanFinding[];
  autoFixes: AutoFixRecord[];
  threatSummary: string;
  costEstimate: { monthlyTotal: number; breakdown: { compute: number; storage: number; networking: number; ssl: number } } | null;
  resourcePlan: ResourcePlan | null;
  status: string;
  createdAt: string;
}

interface ResourceRequirement {
  type: string;
  useCase: string;
  required: boolean;
  reasoning: string;
  evidence: string[];
  strategy: 'auto_provision' | 'user_provided' | 'already_configured' | 'skip';
  envVars: Array<{ key: string; description: string; required: boolean; example?: string }>;
  sizing?: string;
}

interface ResourcePlan {
  summary: string;
  requirements: ResourceRequirement[];
  missingUserEnvVars: Array<{ key: string; description: string; example?: string }>;
  provider: string;
  canAutoDeploy: boolean;
  blockers: string[];
}

interface Deployment {
  id: string;
  cloudRunService: string | null;
  cloudRunUrl: string | null;
  customDomain: string | null;
  sslStatus: string | null;
  healthStatus: string;
  deployedAt: string | null;
  createdAt: string;
  version?: number;
  imageUri?: string | null;
  revisionName?: string | null;
  previewUrl?: string | null;
  isPublished?: boolean;
  publishedAt?: string | null;
}

interface VersionInfo {
  id: string;
  version: number;
  cloudRunService: string | null;
  cloudRunUrl: string | null;
  customDomain: string | null;
  imageUri: string | null;
  revisionName: string | null;
  previewUrl: string | null;
  healthStatus: string;
  isPublished: boolean;
  publishedAt: string | null;
  deployedAt: string | null;
  createdAt: string;
  deployedSourceGcsUri?: string | null;
}

interface ProjectDetail {
  project: Project;
  scanReport: ScanReport | null;
  deployments: Deployment[];
  timeline: TimelineEntry[];
}

export default function ProjectDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const { user: currentUser } = useAuth();
  const isAdmin = (currentUser?.role_name === 'admin') || (currentUser?.permissions?.includes('*') ?? false);
  const [data, setData] = useState<ProjectDetail | null>(null);
  const [showAdminDetail, setShowAdminDetail] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryingDomain, setRetryingDomain] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [showEnvEditor, setShowEnvEditor] = useState(false);
  const [versions, setVersions] = useState<VersionInfo[]>([]);
  const [deployLocked, setDeployLocked] = useState(false);
  const [publishing, setPublishing] = useState<string | null>(null);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [upgradeFile, setUpgradeFile] = useState<File | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [upgradeProgress, setUpgradeProgress] = useState<number | null>(null);
  const [upgradeFailure, setUpgradeFailure] = useState<UploadFailure | null>(null);
  const [upgradeDiagnosing, setUpgradeDiagnosing] = useState(false);
  const upgradeXhrRef = useRef<XMLHttpRequest | null>(null);
  const [upgradeDragOver, setUpgradeDragOver] = useState(false);
  // GitHub webhook state
  const [webhookConfig, setWebhookConfig] = useState<{
    configured: boolean;
    repoUrl?: string;
    branch?: string;
    autoDeployEnabled?: boolean;
    webhookUrl?: string;
    maskedSecret?: string;
  } | null>(null);
  const [webhookRepoUrl, setWebhookRepoUrl] = useState('');
  const [webhookBranch, setWebhookBranch] = useState('main');
  const [webhookSaving, setWebhookSaving] = useState(false);
  const [webhookNewSecret, setWebhookNewSecret] = useState<string | null>(null);
  const [webhookCopied, setWebhookCopied] = useState<string | null>(null);

  const t = useTranslations('projectDetail');
  const tc = useTranslations('common');

  const loadDetail = (silent = false) => {
    if (!silent) setLoading(true);
    fetch(`${API}/api/projects/${id}/detail`, { credentials: 'include' })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => { setData(d); setLoading(false); })
      .catch((err) => { setError(err.message); setLoading(false); });
  };

  const loadVersions = () => {
    fetch(`${API}/api/projects/${id}/versions`, { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (d) {
          setVersions(d.versions ?? []);
          setDeployLocked(d.deployLocked ?? false);
        }
      })
      .catch(() => {});
  };

  const loadWebhookConfig = () => {
    fetch(`${API}/api/projects/${id}/github-webhook`, { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) setWebhookConfig(d); })
      .catch(() => {});
  };

  useEffect(() => {
    loadDetail();
    loadVersions();
    loadWebhookConfig();
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      loadDetail(true);
      loadVersions();
    }, 5000);
    return () => clearInterval(interval);
  }, [id]);

  const handleRetry = async () => {
    setRetrying(true);
    try {
      const res = await fetch(`${API}/api/projects/${id}/resubmit`, { credentials: 'include', method: 'POST' });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
      loadDetail();
    } catch (err) {
      alert((err as Error).message);
    }
    setRetrying(false);
  };

  const handleRetryDomain = async () => {
    setRetryingDomain(true);
    try {
      const res = await fetch(`${API}/api/projects/${id}/retry-domain`, { credentials: 'include', method: 'POST' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      loadDetail();
    } catch (err) {
      alert((err as Error).message);
    }
    setRetryingDomain(false);
  };

  const handleReanalyze = async () => {
    setReanalyzing(true);
    try {
      const res = await fetch(`${API}/api/projects/${id}/reanalyze-failure`, { credentials: 'include', method: 'POST' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      await loadDetail();
    } catch (err) {
      alert((err as Error).message);
    }
    setReanalyzing(false);
  };

  const handlePublish = async (deployId: string) => {
    setPublishing(deployId);
    try {
      const res = await fetch(`${API}/api/projects/${id}/versions/${deployId}/publish`, { credentials: 'include', method: 'POST' });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
      loadDetail();
      loadVersions();
    } catch (err) {
      alert((err as Error).message);
    }
    setPublishing(null);
  };

  const handleDownload = async (deployId: string) => {
    try {
      const res = await fetch(`${API}/api/projects/${id}/versions/${deployId}/download`, { credentials: 'include' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      const { signedUrl, filename } = await res.json();
      // Trigger download via a temporary anchor
      const a = document.createElement('a');
      a.href = signedUrl;
      a.download = filename;
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const handleToggleLock = async () => {
    try {
      const res = await fetch(`${API}/api/projects/${id}/deploy-lock`, { credentials: 'include', method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locked: !deployLocked }),
      });
      if (!res.ok) throw new Error('Failed');
      setDeployLocked(!deployLocked);
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const handleUpgradeFailure = async (envelope: UploadErrorEnvelope) => {
    let mapped = mapEnvelope(envelope);
    setUpgradeFailure(mapped);
    if (envelope.code === 'unknown') {
      setUpgradeDiagnosing(true);
      try {
        mapped = await fetchDiagnostic(envelope, API);
        setUpgradeFailure(mapped);
      } finally {
        setUpgradeDiagnosing(false);
      }
    }
  };

  const handleUpgrade = async () => {
    if (!upgradeFile) return;
    setUpgrading(true);
    setUpgradeFailure(null);

    // Stage: init
    let initData: { uploadUrl: string; gcsUri: string; contentType?: string };
    try {
      const initRes = await fetch(`${API}/api/upload/init`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: upgradeFile.name,
          fileSize: upgradeFile.size,
          contentType: upgradeFile.type || 'application/zip',
        }),
      });
      if (!initRes.ok) {
        const data = (await initRes.json()) as Partial<UploadErrorEnvelope> & { error?: string };
        const env: UploadErrorEnvelope = {
          ok: false,
          stage: data.stage ?? 'init',
          code: data.code ?? 'init_session_failed',
          message: data.message ?? data.error ?? `Init failed: HTTP ${initRes.status}`,
          detail: data.detail,
          retryable: data.retryable ?? true,
        };
        await handleUpgradeFailure(env);
        setUpgrading(false);
        setUpgradeProgress(null);
        return;
      }
      initData = await initRes.json();
    } catch (err) {
      await handleUpgradeFailure(mapClientError(err, { stage: 'init' }).raw);
      setUpgrading(false);
      setUpgradeProgress(null);
      return;
    }

    const { uploadUrl, gcsUri, contentType } = initData;

    // Stage: upload (chunked GCS resumable PUT — Round 27 fix for large-file network errors)
    // Round 44: verifyComplete rescues the trans-Pacific case (bytes landed,
    // 200 response cut on return path → onerror despite GCS-side success).
    const upgradeResult = await uploadResumable({
      sessionUri: uploadUrl,
      file: upgradeFile,
      contentType: contentType || upgradeFile.type || 'application/zip',
      onProgress: (loaded, total) => {
        setUpgradeProgress(Math.round((loaded / total) * 100));
      },
      onXhrCreated: (xhr) => {
        upgradeXhrRef.current = xhr;
      },
      verifyComplete: async () => {
        try {
          const verifyRes = await fetch(`${API}/api/upload/verify`, {
            credentials: 'include',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gcsUri, expectedSize: upgradeFile.size }),
          });
          if (!verifyRes.ok) return false;
          const data = (await verifyRes.json()) as { complete?: boolean };
          return data.complete === true;
        } catch {
          return false;
        }
      },
    });
    upgradeXhrRef.current = null;
    if (!upgradeResult.ok) {
      const env: UploadErrorEnvelope = (() => {
        const f = upgradeResult.failure;
        switch (f.kind) {
          case 'network_error':
            return {
              ok: false,
              stage: 'upload',
              code: 'network_error',
              message: `Network error during GCS upload (chunk ${f.chunkStart}-${f.chunkEnd}, ${f.attempts} attempts)`,
              detail: { chunkStart: f.chunkStart, chunkEnd: f.chunkEnd, attempts: f.attempts, lastError: f.lastError },
              retryable: true,
            };
          case 'gcs_timeout':
            return {
              ok: false,
              stage: 'upload',
              code: 'gcs_timeout',
              message: `Upload timed out on chunk ${f.chunkStart}-${f.chunkEnd}`,
              detail: { chunkStart: f.chunkStart, chunkEnd: f.chunkEnd, attempts: f.attempts },
              retryable: true,
            };
          case 'gcs_auth_failed':
            return {
              ok: false,
              stage: 'upload',
              code: 'gcs_auth_failed',
              message: `GCS auth failed: HTTP ${f.status}`,
              detail: { gcsStatus: f.status, body: f.body },
              retryable: false,
            };
          case 'session_expired':
            return {
              ok: false,
              stage: 'upload',
              code: 'init_session_failed',
              message: `Upload session expired (HTTP ${f.status}). Please retry — the system will create a new session.`,
              detail: { gcsStatus: f.status, body: f.body },
              retryable: true,
            };
          case 'gcs_http_error':
            return {
              ok: false,
              stage: 'upload',
              code: 'submit_failed',
              message: `GCS PUT failed: HTTP ${f.status}`,
              detail: { gcsStatus: f.status, body: f.body, chunkStart: f.chunkStart, chunkEnd: f.chunkEnd },
              retryable: true,
            };
          case 'aborted':
            return {
              ok: false,
              stage: 'upload',
              code: 'network_error',
              message: 'Upload cancelled',
              retryable: true,
            };
        }
      })();
      await handleUpgradeFailure(env);
      setUpgrading(false);
      setUpgradeProgress(null);
      return;
    }
    setUpgradeProgress(null);

    // Stage: submit (new-version)
    try {
      const newVerRes = await fetch(`${API}/api/projects/${id}/new-version`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gcsUri, fileName: upgradeFile.name }),
      });
      if (!newVerRes.ok) {
        const data = (await newVerRes.json()) as Partial<UploadErrorEnvelope> & { error?: string };
        const env: UploadErrorEnvelope = {
          ok: false,
          stage: data.stage ?? 'submit',
          code: data.code ?? 'submit_failed',
          message: data.message ?? data.error ?? `HTTP ${newVerRes.status}`,
          detail: data.detail,
          retryable: data.retryable ?? true,
        };
        await handleUpgradeFailure(env);
        setUpgrading(false);
        return;
      }
    } catch (err) {
      await handleUpgradeFailure(mapClientError(err, { stage: 'submit' }).raw);
      setUpgrading(false);
      return;
    }

    setShowUpgradeModal(false);
    setUpgradeFile(null);
    setUpgradeFailure(null);
    loadDetail();
    loadVersions();
    setUpgrading(false);
  };

  const handleSetupWebhook = async () => {
    if (!webhookRepoUrl.trim()) return;
    setWebhookSaving(true);
    try {
      const res = await fetch(`${API}/api/projects/${id}/github-webhook`, { credentials: 'include', method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl: webhookRepoUrl, branch: webhookBranch, autoDeployEnabled: true }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
      const result = await res.json();
      setWebhookNewSecret(result.webhookSecret);
      loadWebhookConfig();
    } catch (err) {
      alert((err as Error).message);
    }
    setWebhookSaving(false);
  };

  const handleRemoveWebhook = async () => {
    if (!confirm(t('confirmRemoveWebhook'))) return;
    try {
      const res = await fetch(`${API}/api/projects/${id}/github-webhook`, { credentials: 'include', method: 'DELETE' });
      if (!res.ok) throw new Error('Failed');
      setWebhookConfig({ configured: false });
      setWebhookNewSecret(null);
      setWebhookRepoUrl('');
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const handleToggleAutoDeploy = async () => {
    if (!webhookConfig?.configured) return;
    try {
      const res = await fetch(`${API}/api/projects/${id}/github-webhook`, { credentials: 'include', method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoDeployEnabled: !webhookConfig.autoDeployEnabled }),
      });
      if (!res.ok) throw new Error('Failed');
      setWebhookConfig({ ...webhookConfig, autoDeployEnabled: !webhookConfig.autoDeployEnabled });
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setWebhookCopied(label);
      setTimeout(() => setWebhookCopied(null), 2000);
    });
  };

  if (loading) {
    return (
      <div>
        <BackLink t={t} />
        <div style={{ marginTop: 24 }}>
          {[1, 2, 3, 4].map((i) => (
            <div key={i} style={{
              height: 48, background: 'var(--bg-secondary)', borderRadius: 'var(--r-sm)',
              marginBottom: 8, animation: 'pulse 1.5s ease-in-out infinite',
            }} />
          ))}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div>
        <BackLink t={t} />
        <div style={{ marginTop: 24, padding: 16, background: 'var(--danger-bg)', borderRadius: 'var(--r-sm)', border: '1px solid var(--status-critical)' }}>
          <p>{t('loadFailed', { error: error ?? t('notFound') })}</p>
          <button className="btn" style={{ marginTop: 8 }} onClick={() => window.location.reload()}>{tc('retry')}</button>
        </div>
      </div>
    );
  }

  const { project, scanReport, deployments, timeline } = data;

  return (
    <div>
      <BackLink t={t} />

      {/* Hero — 4.0 design system */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24, marginTop: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <h1 style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 'var(--lh-tight)', color: 'var(--ink-900)' }}>
              {project.name}
            </h1>
            <StatusPill status={project.status} />
          </div>
          <p style={{ color: 'var(--ink-500)', fontSize: 'var(--fs-sm)', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
            <span>{project.sourceType}</span>
            <span style={{ color: 'var(--ink-300)' }}>&middot;</span>
            <span>slug: <code>{project.slug}</code></span>
            <span style={{ color: 'var(--ink-300)' }}>&middot;</span>
            <span>created {new Date(project.createdAt).toLocaleString()}</span>
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {(project.status === 'live' || project.status === 'stopped' || project.status === 'failed') && (
            <button className="btn btn-primary" onClick={() => setShowUpgradeModal(true)}>
              + {t('upgradeVersion')}
            </button>
          )}
          {(project.status === 'failed' || project.status === 'needs_revision') && (
            <button className="btn" onClick={handleRetry} disabled={retrying}>
              {retrying ? t('retrying') : t('retryPipeline')}
            </button>
          )}
        </div>
      </div>

      {/* Failure Banner with AI Diagnosis */}
      {project.status === 'failed' && (() => {
        const failEvent = [...timeline].reverse().find((t) => t.toState === 'failed');
        if (!failEvent) return null;
        const meta = (failEvent.metadata ?? {}) as Record<string, unknown>;
        const diag = meta.buildDiagnosis as {
          category?: string;
          ownership?: 'user' | 'platform' | 'environment' | 'unknown';
          summary?: string;
          userFacingMessage?: string;
          adminFacingMessage?: string;
          userActionable?: boolean;
          platformActionable?: boolean;
          rootCause?: string;
          suggestedFix?: string;
          errorLocation?: string | null;
          errorSnippet?: string | null;
          extraObservations?: string | null;
          step?: string | null;
          provider?: string;
        } | undefined;

        const categoryLabels: Record<string, string> = {
          user_code: '🔧 程式碼錯誤',
          dependency: '📦 套件／依賴問題',
          config: '⚙️ 設定問題',
          runtime: '🚀 Runtime 錯誤',
          network: '🌐 網路／連線',
          infra: '☁️ 基礎設施問題',
          unknown: '❓ 未知',
        };

        const ownershipLabels: Record<string, { label: string; color: string; bg: string; hint: string }> = {
          user: { label: '👤 你的程式碼需要修正', color: 'var(--warn)', bg: 'var(--warn-bg)', hint: '請依下方建議修改並重新部署' },
          platform: { label: '🔧 平台問題，管理員處理中', color: 'var(--info)', bg: 'var(--info-bg)', hint: '這不是你的錯，平台正在排查' },
          environment: { label: '🌐 環境／外部問題', color: '#8957e5', bg: 'rgba(137,87,229,0.1)', hint: '通常重試即可（GCP/網路暫時性問題）' },
          unknown: { label: '❓ 判斷不出來', color: 'var(--ink-400)', bg: 'var(--ink-50)', hint: '需要更多資訊才能判斷' },
        };
        const ownershipInfo = ownershipLabels[diag?.ownership ?? 'unknown'];

        const codeBlockStyle: React.CSSProperties = {
          padding: '10px 12px', background: 'var(--ink-50)', borderRadius: 'var(--r-sm)',
          fontFamily: 'var(--font-mono, monospace)', fontSize: 'var(--fs-xs)',
          color: 'var(--ink-900)', lineHeight: 1.55,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          border: '1px solid var(--ink-100)',
        };

        return (
          <div style={{
            marginTop: 12, padding: 16, background: 'var(--danger-bg)',
            borderRadius: 'var(--r-sm)', border: '1px solid var(--danger)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 'var(--fs-sm)' }}>&#x26A0;&#xFE0F;</span>
              <strong style={{ color: 'var(--status-critical)', fontSize: 'var(--fs-xs)' }}>
                {project.name} 部署失敗{meta.failedStep ? ` — ${String(meta.failedStep)}` : ''}
              </strong>
              {diag && (
                <span className="pill" style={{
                  background: ownershipInfo.bg,
                  color: ownershipInfo.color,
                  fontSize: 'var(--fs-xs)',
                  fontWeight: 600,
                  padding: '3px 10px',
                  border: `1px solid ${ownershipInfo.color}44`,
                }}>
                  {ownershipInfo.label}
                </span>
              )}
              {diag?.category && (
                <span className="pill" style={{ background: 'var(--status-critical-bg)', color: 'var(--status-critical)', fontSize: 11 }}>
                  {categoryLabels[diag.category] ?? diag.category}
                </span>
              )}
              {diag?.provider && (
                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>AI by {diag.provider}</span>
              )}
            </div>

            {/* AI 診斷（有的話先秀） */}
            {diag ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {/* ─── 使用者面向 ─── */}
                {diag.userFacingMessage ? (
                  <div style={{
                    padding: '14px 16px',
                    background: ownershipInfo.bg,
                    borderRadius: 'var(--r-sm)',
                    border: `1px solid ${ownershipInfo.color}55`,
                    fontSize: 'var(--fs-xs)',
                    lineHeight: 1.7,
                  }}>
                    <div style={{
                      color: ownershipInfo.color,
                      fontWeight: 600,
                      fontSize: 'var(--fs-xs)',
                      marginBottom: 6,
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                    }}>
                      給使用者的建議 · {ownershipInfo.hint}
                    </div>
                    <div style={{ color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>{diag.userFacingMessage}</div>
                  </div>
                ) : (
                  // 舊版診斷（無 userFacingMessage）—— 提示使用者 / 管理員可重新分析
                  <div style={{
                    padding: '10px 12px',
                    background: 'var(--ink-50)',
                    borderRadius: 'var(--r-sm)',
                    border: '1px dashed var(--ink-200)',
                    fontSize: 'var(--fs-xs)',
                    color: 'var(--text-secondary)',
                    lineHeight: 1.6,
                  }}>
                    這是舊版診斷格式，尚未產生使用者面向摘要。
                    {isAdmin ? '請按下方「🤖 重新分析」取得最新的使用者／管理員雙面向診斷。' : '請聯絡管理員點擊「重新分析」以取得使用者面向的建議。'}
                  </div>
                )}

                {/* 錯誤地點 + 片段 —— 使用者修 code 時最需要看的 */}
                {diag.errorLocation && (
                  <div style={{ fontSize: 'var(--fs-xs)' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>錯誤地點：</span>
                    <code style={{ background: 'var(--ink-100)', padding: '2px 6px', borderRadius: 'var(--r-sm)', color: 'var(--danger)' }}>
                      {diag.errorLocation}
                    </code>
                  </div>
                )}
                {diag.errorSnippet && (
                  <div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-xs)', marginBottom: 4 }}>錯誤片段：</div>
                    <div style={codeBlockStyle}>{diag.errorSnippet}</div>
                  </div>
                )}
                {diag.extraObservations && (
                  <div style={{
                    padding: '8px 12px', background: 'var(--warn-bg)',
                    borderRadius: 'var(--r-sm)', border: '1px solid var(--warn)',
                    fontSize: 'var(--fs-xs)', lineHeight: 1.6, color: 'var(--text-secondary)',
                  }}>
                    <strong style={{ color: 'var(--warn)' }}>附加觀察：</strong> {diag.extraObservations}
                  </div>
                )}

                {/* ─── 管理員面向（只給 admin 看）─── */}
                {isAdmin && (diag.adminFacingMessage || diag.rootCause) && (
                  <div style={{
                    padding: '10px 12px',
                    background: 'var(--ink-50)',
                    borderRadius: 'var(--r-sm)',
                    border: '1px dashed var(--ink-300)',
                  }}>
                    <button
                      onClick={() => setShowAdminDetail((v) => !v)}
                      style={{
                        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                        color: 'var(--text-secondary)', fontSize: 'var(--fs-xs)', fontWeight: 600,
                        display: 'flex', alignItems: 'center', gap: 6,
                      }}
                    >
                      {showAdminDetail ? '▼' : '▶'} 🔧 管理員技術細節（只有 admin 看得到）
                    </button>
                    {showAdminDetail && (
                      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {diag.adminFacingMessage && (
                          <div style={{ fontSize: 'var(--fs-xs)', lineHeight: 1.6, color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>
                            <strong style={{ color: 'var(--text-secondary)' }}>平台層分析：</strong><br />
                            {diag.adminFacingMessage}
                          </div>
                        )}
                        {diag.rootCause && diag.rootCause !== diag.adminFacingMessage && (
                          <div style={{ fontSize: 'var(--fs-xs)', lineHeight: 1.6, color: 'var(--text-secondary)' }}>
                            <strong>根本原因：</strong> {diag.rootCause}
                          </div>
                        )}
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 10 }}>
                          <span>userActionable: {diag.userActionable === undefined ? 'n/a' : String(diag.userActionable)}</span>
                          <span>platformActionable: {diag.platformActionable === undefined ? 'n/a' : String(diag.platformActionable)}</span>
                        </div>
                        {meta.error ? (
                          <details>
                            <summary style={{ color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer' }}>
                              原始錯誤訊息（raw）
                            </summary>
                            <div style={{ ...codeBlockStyle, fontSize: 11, marginTop: 6, color: 'var(--status-critical)' }}>
                              {String(meta.error)}
                            </div>
                          </details>
                        ) : null}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              // Fallback：完全沒有 LLM 診斷（舊資料或 LLM 失敗）時只秀原始錯誤；reanalyze 按鈕移到下方 admin-only 區塊
              meta.error ? (
                <div style={codeBlockStyle}>{String(meta.error)}</div>
              ) : null
            )}

            {/* Reanalyze 按鈕 —— admin only，永遠可觸發（新／舊／空診斷都能刷新）*/}
            {isAdmin && (
              <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button
                  className="btn"
                  onClick={handleReanalyze}
                  disabled={reanalyzing}
                  style={{
                    background: 'var(--info-bg)',
                    border: '1px solid var(--info)',
                    color: 'var(--info)',
                    fontSize: 'var(--fs-sm)',
                    padding: '6px var(--sp-3)',
                  }}
                >
                  {reanalyzing ? '分析中…' : diag ? '🤖 重新分析（刷新診斷）' : '🤖 用 AI 重新分析失敗原因'}
                </button>
                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                  抓取 Cloud Build log 並用 Claude/GPT 產出 使用者／管理員 雙面向診斷
                </span>
              </div>
            )}

            {isAdmin && meta.stack ? (
              <details style={{ marginTop: 10 }}>
                <summary style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)', cursor: 'pointer' }}>Stack Trace（admin）</summary>
                <div style={{ ...codeBlockStyle, fontSize: 11, marginTop: 4, color: 'var(--text-secondary)' }}>
                  {String(meta.stack)}
                </div>
              </details>
            ) : null}
          </div>
        );
      })()}

      {/* Grid: Info + Deployment */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 20 }}>
        {/* Project Info Card */}
        <Card title={t('projectInfo')}>
          <InfoRow label={t('language')} value={project.detectedLanguage ?? '—'} />
          <InfoRow label={t('framework')} value={project.detectedFramework ?? '—'} />
          <InfoRow label={t('sourceType')} value={project.sourceType} />
          <InfoRow label={t('customDomain')} value={project.config?.customDomain ? `${project.config.customDomain}.punwave.com` : tc('none')} />
          <InfoRow label={t('publicAccess')} value={project.config?.allowUnauthenticated ? tc('yes') : tc('no')} />
        </Card>

        {/* Deployment Card */}
        <Card title={t('deploymentInfo')}>
          {deployments.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-xs)' }}>{t('noDeployments')}</p>
          ) : (
            deployments.slice(0, 1).map((d) => {
              const domainName = d.customDomain
                || (project.config?.customDomain
                  ? `${project.config.customDomain}.punwave.com`
                  : null);
              return (
                <div key={d.id} style={{ marginBottom: 12 }}>
                  <InfoRow label={t('service')} value={d.cloudRunService ?? '—'} />
                  {d.cloudRunUrl && (
                    <InfoRow label={t('cloudRunUrl')}>
                      <a href={d.cloudRunUrl} target="_blank" rel="noreferrer"
                        style={{ color: 'var(--accent)', fontSize: 'var(--fs-xs)' }}>{d.cloudRunUrl}</a>
                    </InfoRow>
                  )}
                  {domainName && (
                    <InfoRow label={t('customDomain')}>
                      <a href={`https://${domainName}`} target="_blank" rel="noreferrer"
                        style={{ color: 'var(--accent)', fontSize: 'var(--fs-xs)' }}>https://{domainName}</a>
                    </InfoRow>
                  )}
                  <InfoRow label={t('ssl')} value={d.sslStatus ?? 'N/A'} />
                  {project.config?.domainError && (
                    <div style={{ margin: '8px 0', padding: '8px 12px', background: 'var(--danger-bg)', borderRadius: 'var(--r-sm)', border: '1px solid var(--status-critical)', fontSize: 'var(--fs-xs)' }}>
                      <div style={{ color: 'var(--status-critical)', fontWeight: 500, marginBottom: 4 }}>⚠ Domain 設定失敗</div>
                      <div style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>{String(project.config.domainError)}</div>
                      <button
                        className="btn"
                        disabled={retryingDomain}
                        onClick={handleRetryDomain}
                        style={{ fontSize: 'var(--fs-sm)', padding: '4px var(--sp-3)', color: 'var(--info)', borderColor: 'var(--info)' }}
                      >{retryingDomain ? '重試中...' : '重試 Domain 設定'}</button>
                    </div>
                  )}
                  <InfoRow label={t('healthStatus')}>
                    <span style={{ color: d.healthStatus === 'healthy' ? 'var(--status-live)' : 'var(--text-secondary)' }}>
                      {d.healthStatus}
                    </span>
                  </InfoRow>
                  {d.deployedAt && <InfoRow label={t('deployTime')} value={new Date(d.deployedAt).toLocaleString()} />}
                </div>
              );
            })
          )}
        </Card>
      </div>

      {/* Version History (Netlify-like) */}
      {versions.length > 0 && (
        <Card title={t('versionHistory')} style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
              {t('totalVersions', { count: versions.length })}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {project.status === 'live' && (
                <button className="btn btn-primary" onClick={handleUpgrade}
                  style={{ fontSize: 'var(--fs-xs)', padding: '4px 12px' }}>
                  {t('upgradeVersion')}
                </button>
              )}
              <button
                onClick={handleToggleLock}
                style={{
                  fontSize: 'var(--fs-xs)', padding: '4px 12px', borderRadius: 'var(--r-sm)',
                  background: deployLocked ? 'var(--danger-bg)' : 'var(--bg-primary)',
                  border: `1px solid ${deployLocked ? 'var(--danger)' : 'var(--border)'}`,
                  color: deployLocked ? 'var(--status-critical)' : 'var(--text-secondary)',
                  cursor: 'pointer',
                }}
              >
                {deployLocked ? t('locked') : t('lockDeploy')}
              </button>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {versions.map((v) => (
              <div
                key={v.id}
                style={{
                  padding: '12px 16px',
                  background: v.isPublished ? 'var(--ok-bg)' : 'var(--bg-primary)',
                  border: `1px solid ${v.isPublished ? 'var(--ok)' : 'var(--border)'}`,
                  borderRadius: 'var(--r-sm)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontWeight: 600, fontSize: 'var(--fs-xs)' }}>v{v.version}</span>
                    {v.isPublished && (
                      <span style={{
                        fontSize: 11, padding: '2px 8px', borderRadius: 'var(--r-sm)',
                        background: 'var(--ok-bg)', color: 'var(--status-live)',
                        fontWeight: 500,
                      }}>
                        LIVE
                      </span>
                    )}
                    <span style={{
                      fontSize: 11, padding: '2px 8px', borderRadius: 'var(--r-sm)',
                      background: v.healthStatus === 'healthy' ? 'var(--ok-bg)' :
                                  v.healthStatus === 'unhealthy' ? 'var(--danger-bg)' : 'var(--bg-secondary)',
                      color: v.healthStatus === 'healthy' ? 'var(--status-live)' :
                             v.healthStatus === 'unhealthy' ? 'var(--status-critical)' : 'var(--text-secondary)',
                    }}>
                      {v.healthStatus}
                    </span>
                  </div>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
                    {v.deployedAt ? new Date(v.deployedAt).toLocaleString() : tc('deploying')}
                    {v.revisionName && <span> &middot; {v.revisionName}</span>}
                  </div>
                  {v.previewUrl && (
                    <a href={v.previewUrl} target="_blank" rel="noreferrer"
                      style={{ fontSize: 11, color: 'var(--accent)', marginTop: 2, display: 'inline-block', textDecoration: 'none' }}>
                      {v.previewUrl.includes('---') ? `Preview: v${v.version}` : 'Preview URL'} ↗
                    </a>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {v.deployedSourceGcsUri && (
                    <button
                      onClick={() => handleDownload(v.id)}
                      title={t('downloadSourceHint')}
                      style={{
                        fontSize: 'var(--fs-xs)', padding: '6px 14px', borderRadius: 'var(--r-sm)',
                        background: 'transparent', color: 'var(--accent)',
                        border: '1px solid var(--accent)', cursor: 'pointer',
                      }}
                    >
                      {t('downloadSource')}
                    </button>
                  )}
                  {!v.isPublished && v.revisionName && (
                    <button
                      onClick={() => handlePublish(v.id)}
                      disabled={publishing === v.id}
                      style={{
                        fontSize: 'var(--fs-xs)', padding: '6px 14px', borderRadius: 'var(--r-sm)',
                        background: 'var(--accent)', color: '#fff', border: 'none',
                        cursor: publishing === v.id ? 'wait' : 'pointer',
                        opacity: publishing === v.id ? 0.6 : 1,
                      }}
                    >
                      {publishing === v.id ? t('publishing') : t('publishVersion')}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* GitHub Auto-Deploy */}
      <Card title={t('githubAutoDeploy')} style={{ marginTop: 16 }}>
        {webhookConfig?.configured ? (
          <div>
            {/* Configured state */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>Repository</span>
                <a href={webhookConfig.repoUrl} target="_blank" rel="noreferrer"
                  style={{ fontSize: 'var(--fs-xs)', color: 'var(--accent)', textDecoration: 'none' }}>
                  {webhookConfig.repoUrl}
                </a>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>Branch</span>
                <span style={{ fontSize: 'var(--fs-xs)', fontFamily: 'monospace' }}>{webhookConfig.branch}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>Webhook URL</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <code style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-primary)', background: 'var(--bg-primary)', padding: '2px 8px', borderRadius: 'var(--r-sm)' }}>
                    {webhookConfig.webhookUrl}
                  </code>
                  <button
                    onClick={() => copyToClipboard(webhookConfig.webhookUrl!, 'url')}
                    style={{
                      fontSize: 11, padding: '3px 8px', borderRadius: 'var(--r-sm)',
                      border: '1px solid var(--border)', background: 'var(--bg-primary)',
                      color: webhookCopied === 'url' ? 'var(--status-live)' : 'var(--text-secondary)',
                      cursor: 'pointer',
                    }}
                  >
                    {webhookCopied === 'url' ? tc('copied') : tc('copy')}
                  </button>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>Secret</span>
                <code style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', background: 'var(--bg-primary)', padding: '2px 8px', borderRadius: 'var(--r-sm)' }}>
                  {webhookConfig.maskedSecret}
                </code>
              </div>
              {webhookNewSecret && (
                <div style={{
                  padding: 12, background: 'var(--ok-bg)', border: '1px solid var(--ok)',
                  borderRadius: 'var(--r-sm)', marginTop: 4,
                }}>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--status-live)', fontWeight: 600, marginBottom: 6 }}>
                    {t('webhookSecretHint')}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <code style={{ fontSize: 'var(--fs-xs)', fontFamily: 'monospace', wordBreak: 'break-all', flex: 1 }}>
                      {webhookNewSecret}
                    </code>
                    <button
                      onClick={() => copyToClipboard(webhookNewSecret, 'secret')}
                      style={{
                        fontSize: 11, padding: '4px 10px', borderRadius: 'var(--r-sm)',
                        border: '1px solid var(--border)', background: 'var(--bg-primary)',
                        color: webhookCopied === 'secret' ? 'var(--status-live)' : 'var(--text-secondary)',
                        cursor: 'pointer', flexShrink: 0,
                      }}
                    >
                      {webhookCopied === 'secret' ? tc('copied') : t('copySecret')}
                    </button>
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>{t('autoDeploy')}</span>
                <button
                  onClick={handleToggleAutoDeploy}
                  style={{
                    fontSize: 'var(--fs-xs)', padding: '4px 14px', borderRadius: 'var(--r-sm)',
                    background: webhookConfig.autoDeployEnabled ? 'var(--ok-bg)' : 'var(--bg-primary)',
                    border: `1px solid ${webhookConfig.autoDeployEnabled ? 'var(--ok)' : 'var(--border)'}`,
                    color: webhookConfig.autoDeployEnabled ? 'var(--status-live)' : 'var(--text-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  {webhookConfig.autoDeployEnabled ? tc('enabled') : tc('disabled')}
                </button>
              </div>
            </div>
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={handleRemoveWebhook}
                style={{
                  fontSize: 'var(--fs-xs)', padding: '4px 14px', borderRadius: 'var(--r-sm)',
                  background: 'transparent', border: '1px solid var(--danger)',
                  color: 'var(--status-critical)', cursor: 'pointer',
                }}
              >
                {t('removeWebhook')}
              </button>
            </div>
            <p style={{ marginTop: 8, fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {t('webhookPushHint', { branch: webhookConfig.branch ?? 'main' })}
            </p>
          </div>
        ) : (
          <div>
            {/* Setup form */}
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', marginBottom: 12 }}>
              {t('webhookSetupHint')}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
                  Repository URL
                </label>
                <input
                  type="text"
                  value={webhookRepoUrl}
                  onChange={(e) => setWebhookRepoUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo"
                  style={{
                    width: '100%', padding: '8px 12px', fontSize: 'var(--fs-xs)', fontFamily: 'monospace',
                    background: 'var(--bg-primary)', border: '1px solid var(--border)',
                    borderRadius: 'var(--r-sm)', color: 'var(--text-primary)', boxSizing: 'border-box',
                  }}
                />
              </div>
              <div>
                <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
                  Branch
                </label>
                <input
                  type="text"
                  value={webhookBranch}
                  onChange={(e) => setWebhookBranch(e.target.value)}
                  placeholder="main"
                  style={{
                    width: 200, padding: '8px 12px', fontSize: 'var(--fs-xs)', fontFamily: 'monospace',
                    background: 'var(--bg-primary)', border: '1px solid var(--border)',
                    borderRadius: 'var(--r-sm)', color: 'var(--text-primary)',
                  }}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                <button
                  onClick={handleSetupWebhook}
                  disabled={webhookSaving || !webhookRepoUrl.trim()}
                  style={{
                    fontSize: 'var(--fs-xs)', padding: '8px 20px', borderRadius: 'var(--r-sm)',
                    background: 'var(--accent)', color: '#fff', border: 'none',
                    cursor: webhookSaving || !webhookRepoUrl.trim() ? 'not-allowed' : 'pointer',
                    opacity: webhookSaving || !webhookRepoUrl.trim() ? 0.5 : 1,
                  }}
                >
                  {webhookSaving ? t('settingUp') : t('enableAutoDeploy')}
                </button>
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* Upgrade Modal */}
      {showUpgradeModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(11,14,20,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
        }} onClick={() => { setShowUpgradeModal(false); setUpgradeFile(null); }}>
          <div style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-md)', padding: 24, width: 480, maxWidth: '90vw',
          }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: 'var(--fs-md)', fontWeight: 600, marginBottom: 16 }}>{t('upgradeModal.title')}</h3>
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', marginBottom: 16 }}>
              {t('upgradeModal.description')}
            </p>
            <div
              onDragOver={(e) => { e.preventDefault(); setUpgradeDragOver(true); }}
              onDragLeave={() => setUpgradeDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setUpgradeDragOver(false);
                const f = e.dataTransfer.files[0];
                if (f) setUpgradeFile(f);
              }}
              onClick={() => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.zip,.tar.gz,.tgz,.tar';
                input.onchange = () => { if (input.files?.[0]) setUpgradeFile(input.files[0]); };
                input.click();
              }}
              style={{
                border: `2px dashed ${upgradeDragOver ? 'var(--accent)' : upgradeFile ? 'var(--status-live)' : 'var(--border)'}`,
                borderRadius: 'var(--r-sm)', padding: upgradeFile ? '16px' : '32px 16px',
                textAlign: 'center', cursor: 'pointer',
                background: upgradeDragOver ? 'var(--sea-50)' : 'var(--bg-primary)',
              }}
            >
              {upgradeFile ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
                  <div style={{ textAlign: 'left' }}>
                    <div style={{ fontWeight: 500, fontSize: 'var(--fs-xs)' }}>{upgradeFile.name}</div>
                    <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
                      {(upgradeFile.size / 1024 / 1024).toFixed(1)} MB
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-xs)' }}>
                  {t('upgradeModal.dragHint')}
                </div>
              )}
            </div>
            {upgradeProgress !== null && (
              <div style={{ marginTop: 12, padding: 'var(--sp-3)', background: 'var(--info-bg)', border: '1px solid var(--info)', borderRadius: 'var(--r-md)', fontSize: 'var(--fs-xs)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, color: 'var(--info)' }}>
                  <span>上傳到 GCS</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono, monospace)' }}>{upgradeProgress}%</span>
                </div>
                <div style={{ height: 6, background: 'var(--ink-100)', borderRadius: 'var(--r-pill)', overflow: 'hidden' }}>
                  <div style={{ width: `${upgradeProgress}%`, height: '100%', background: 'var(--info)', transition: 'width 200ms ease' }} />
                </div>
              </div>
            )}
            {upgradeFailure && (
              <UploadErrorBlock
                failure={upgradeFailure}
                context={{
                  projectId: id as string,
                  fileMeta: upgradeFile ? { name: upgradeFile.name, size: upgradeFile.size } : undefined,
                }}
                diagnosing={upgradeDiagnosing}
                onRetry={() => {
                  setUpgradeFailure(null);
                  void handleUpgrade();
                }}
                onCancel={() => {
                  setUpgradeFailure(null);
                  setUpgrading(false);
                  if (upgradeXhrRef.current) {
                    try { upgradeXhrRef.current.abort(); } catch { /* ignore */ }
                    upgradeXhrRef.current = null;
                  }
                }}
              />
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button onClick={() => { setShowUpgradeModal(false); setUpgradeFile(null); }}
                style={{ fontSize: 'var(--fs-xs)', padding: '8px 16px', borderRadius: 'var(--r-sm)', background: 'var(--bg-primary)', border: '1px solid var(--border)', cursor: 'pointer', color: 'var(--text-primary)' }}>
                {tc('cancel')}
              </button>
              <button onClick={handleUpgrade} disabled={!upgradeFile || upgrading}
                style={{
                  fontSize: 'var(--fs-xs)', padding: '8px 16px', borderRadius: 'var(--r-sm)',
                  background: upgradeFile ? 'var(--accent)' : 'var(--bg-primary)',
                  color: upgradeFile ? '#fff' : 'var(--text-secondary)',
                  border: 'none', cursor: upgradeFile ? 'pointer' : 'not-allowed',
                  opacity: upgrading ? 0.6 : 1,
                }}>
                {upgrading ? t('upgradeModal.uploading') : t('upgradeModal.startUpgrade')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Environment Variables */}
      {deployments.length > 0 && (
        <EnvVarsSection
          projectId={project.id}
          expanded={showEnvEditor}
          onToggle={() => setShowEnvEditor(!showEnvEditor)}
        />
      )}

      {/* Scan Report */}
      {scanReport && <ScanReportSection scanReport={scanReport} projectStatus={project.status} projectId={project.id} />}

      {/* Pipeline Timeline */}
      <Card title={t('timeline.title')} style={{ marginTop: 16 }}>
        {timeline.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-xs)' }}>{t('timeline.noEvents')}</p>
        ) : (
          <div style={{ position: 'relative', paddingLeft: 24 }}>
            {/* Vertical line */}
            <div style={{
              position: 'absolute', left: 7, top: 4, bottom: 4, width: 2,
              background: 'var(--border)',
            }} />
            {timeline.map((entry, i) => {
              const isLast = i === timeline.length - 1;
              const isFailed = entry.toState === 'failed';
              const isLive = entry.toState === 'live';
              return (
                <div key={entry.id} style={{ position: 'relative', paddingBottom: isLast ? 0 : 16 }}>
                  {/* Dot */}
                  <div style={{
                    position: 'absolute', left: -20, top: 3,
                    width: 12, height: 12, borderRadius: '50%',
                    background: isFailed ? 'var(--status-critical)' : isLive ? 'var(--status-live)' : isLast ? 'var(--accent)' : 'var(--border)',
                    border: '2px solid var(--bg-secondary)',
                  }} />
                  {/* Content */}
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <StatusPill status={entry.toState} />
                      {entry.fromState && (
                        <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
                          from {entry.fromState.replace(/_/g, ' ')}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', marginTop: 2 }}>
                      {new Date(entry.createdAt).toLocaleString()} &middot; by {entry.triggeredBy}
                    </div>
                    {/* Show metadata if there's useful info */}
                    {entry.metadata && Object.keys(entry.metadata).length > 0 && (
                      <MetadataBlock metadata={entry.metadata} t={t} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

/* --- Sub-components --- */

function BackLink({ t }: { t: (key: string) => string }) {
  return (
    <a href="/" style={{ color: 'var(--ink-500)', fontSize: 'var(--fs-sm)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      &larr; {t('backToProjects')}
    </a>
  );
}

function Card({ title, subtle, children, style }: { title: string; subtle?: React.ReactNode; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <section
      style={{
        background: 'var(--surface-1)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-lg)',
        padding: 'var(--sp-5)',
        ...style,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 'var(--sp-4)',
        }}
      >
        <h3 style={{ fontSize: 'var(--fs-lg)', fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ink-900)' }}>
          {title}
        </h3>
        {subtle ? <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-500)' }}>{subtle}</span> : null}
      </header>
      {children}
    </section>
  );
}

function InfoRow({ label, value, mono, children }: {
  label: string; value?: string; mono?: boolean; children?: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'baseline',
      gap: 12,
      paddingTop: 10,
      paddingBottom: 10,
      borderTop: '1px solid var(--ink-100)',
      fontSize: 'var(--fs-sm)',
    }}>
      <span style={{ color: 'var(--ink-500)', minWidth: 110, flexShrink: 0 }}>{label}</span>
      {children ?? (
        <span style={{
          color: 'var(--ink-900)',
          fontFamily: mono ? 'var(--font-mono, monospace)' : 'inherit',
          overflowWrap: 'anywhere',
          wordBreak: 'normal',
          minWidth: 0,
        }}>
          {value}
        </span>
      )}
    </div>
  );
}

function MetadataBlock({ metadata, t }: { metadata: Record<string, unknown>; t: (key: string, values?: Record<string, string>) => string }) {
  const entries = Object.entries(metadata).filter(([k]) => k !== 'trigger' && k !== 'stack');

  if (entries.length === 0) return null;

  const errorMsg = metadata.error as string | undefined;
  const failedStep = metadata.failedStep as string | undefined;
  const stack = metadata.stack as string | undefined;

  // Error state: show error with step info
  if (errorMsg) {
    return (
      <div style={{ marginTop: 6 }}>
        {failedStep && (
          <div style={{
            fontSize: 11, color: 'var(--status-critical)', marginBottom: 4, fontWeight: 500,
          }}>
            {t('timeline.failedAt', { step: failedStep })}
          </div>
        )}
        <div style={{
          padding: '6px 10px', background: 'var(--danger-bg)',
          borderRadius: 'var(--r-sm)', border: '1px solid var(--danger)',
          fontSize: 'var(--fs-xs)', color: 'var(--status-critical)', fontFamily: 'monospace',
          wordBreak: 'break-all', lineHeight: 1.5,
        }}>
          {errorMsg}
        </div>
        {stack && (
          <details style={{ marginTop: 4 }}>
            <summary style={{ color: 'var(--text-secondary)', fontSize: 11, cursor: 'pointer' }}>
              Stack trace
            </summary>
            <div style={{
              marginTop: 2, padding: '4px 8px', background: 'var(--ink-100)', borderRadius: 'var(--r-sm)',
              fontFamily: 'monospace', fontSize: 10, color: 'var(--text-secondary)',
              lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            }}>
              {stack}
            </div>
          </details>
        )}
      </div>
    );
  }

  // Normal metadata badges
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
      {entries.map(([key, val]) => (
        <span key={key} style={{
          display: 'inline-block', padding: '2px 8px', borderRadius: 'var(--r-sm)',
          background: 'var(--bg-primary)', border: '1px solid var(--border)',
          fontSize: 11, color: 'var(--text-secondary)',
        }}>
          {key.replace(/([A-Z])/g, ' $1').toLowerCase()}: <strong style={{ color: 'var(--text-primary)' }}>{val === null || val === undefined ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val)}</strong>
        </span>
      ))}
    </div>
  );
}

function ScanReportSection({ scanReport, projectStatus, projectId }: { scanReport: ScanReport; projectStatus: string; projectId: string }) {
  const t = useTranslations('projectDetail.scanReport');
  const postReview = ['approved', 'deploying', 'deployed', 'ssl_provisioning', 'canary_check', 'live'].includes(projectStatus);
  const [expanded, setExpanded] = useState(!postReview);

  const findings = scanReport.findings ?? [];
  const autoFixes = scanReport.autoFixes ?? [];
  const criticalCount = findings.filter(f => f.severity === 'critical').length;
  const highCount = findings.filter(f => f.severity === 'high').length;
  const mediumCount = findings.filter(f => f.severity === 'medium').length;
  const lowCount = findings.filter(f => f.severity === 'low').length;

  return (
    <div style={{
      background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
      padding: 16, marginTop: 16,
    }}>
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
        onClick={() => setExpanded(!expanded)}
      >
        <h3 style={{ fontSize: 'var(--fs-xs)', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-secondary)', letterSpacing: 0.5, margin: 0 }}>
          {expanded ? '\u25BC' : '\u25B6'}&nbsp; {t('title')}
        </h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {findings.length > 0 && (
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
              {findings.length} findings
              {autoFixes.length > 0 && ` (${autoFixes.length} auto-fixed)`}
            </span>
          )}
          <span className={`pill ${scanReport.status === 'completed' ? 'pill-live' : scanReport.status === 'scanning' ? 'pill-scanning' : 'pill-review'}`}>
            {scanReport.status}
          </span>
          {scanReport.costEstimate && (
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
              ~${scanReport.costEstimate.monthlyTotal.toFixed(2)}/mo
            </span>
          )}
          {scanReport.status === 'completed' && (
            <a
              href={`${API}/api/projects/${projectId}/scan/report`}
              download
              onClick={(e) => e.stopPropagation()}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '4px 10px', fontSize: 'var(--fs-xs)', fontWeight: 500,
                background: 'var(--bg-tertiary)', color: 'var(--accent-blue)',
                border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
                textDecoration: 'none', cursor: 'pointer',
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--border)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
            >
              <span style={{ fontSize: 'var(--fs-xs)' }}>&#8681;</span> {t('downloadReport')}
            </a>
          )}
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: 12 }}>
          {/* Severity summary bar */}
          {findings.length > 0 && (
            <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
              {criticalCount > 0 && <SeverityBadge severity="critical" count={criticalCount} />}
              {highCount > 0 && <SeverityBadge severity="high" count={highCount} />}
              {mediumCount > 0 && <SeverityBadge severity="medium" count={mediumCount} />}
              {lowCount > 0 && <SeverityBadge severity="low" count={lowCount} />}
            </div>
          )}

          {/* Resource Plan */}
          {scanReport.resourcePlan && <ResourcePlanCard plan={scanReport.resourcePlan} />}

          {/* Threat summary */}
          {scanReport.threatSummary && (
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', marginBottom: 4, textTransform: 'uppercase' }}>
                {t('threatSummary')}
              </label>
              <div style={{
                background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
                padding: 12, fontSize: 'var(--fs-xs)', lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: 300,
                overflowY: 'auto', fontFamily: 'monospace',
              }}>
                {scanReport.threatSummary}
              </div>
            </div>
          )}

          {/* Findings list */}
          {findings.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase' }}>
                {t('securityFindings', { count: findings.length })}
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {findings.map((f, i) => (
                  <FindingCard key={f.id || i} finding={f} />
                ))}
              </div>
            </div>
          )}

          {/* Auto-fixes list */}
          {autoFixes.length > 0 && (
            <div>
              <label style={{ display: 'block', fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase' }}>
                {t('autoFixes', { count: autoFixes.length })}
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {autoFixes.map((fix, i) => (
                  <AutoFixCard key={i} fix={fix} />
                ))}
              </div>
            </div>
          )}

          {findings.length === 0 && !scanReport.threatSummary && (
            <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-xs)' }}>{t('scanningInProgress')}</p>
          )}
        </div>
      )}
    </div>
  );
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'var(--danger)',
  high: 'var(--warn)',
  medium: 'var(--warn)',
  low: 'var(--ink-400)',
};

function ResourcePlanCard({ plan }: { plan: ResourcePlan }) {
  const [expanded, setExpanded] = useState(true);
  const t = useTranslations('projectDetail.scanReport');

  const strategyLabel: Record<string, { label: string; color: string }> = {
    auto_provision: { label: t('autoProvision'), color: 'var(--ok)' },
    user_provided: { label: t('userProvided'), color: 'var(--warn)' },
    already_configured: { label: t('alreadyConfigured'), color: 'var(--info)' },
    skip: { label: t('skip'), color: 'var(--ink-400)' },
  };

  return (
    <div style={{ marginBottom: 16, border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--bg-primary)' }}>
      <div
        style={{ padding: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        onClick={() => setExpanded(!expanded)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>{expanded ? '\u25BC' : '\u25B6'}</span>
          <span style={{ fontSize: 'var(--fs-xs)', fontWeight: 600 }}>
            {t('deploymentPlan', { count: plan.requirements.length })}
          </span>
          {plan.canAutoDeploy ? (
            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 'var(--r-sm)', background: 'var(--ok-bg)', color: 'var(--ok)' }}>
              {t('autoDeployable')}
            </span>
          ) : (
            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 'var(--r-sm)', background: 'var(--warn-bg)', color: 'var(--warn)' }}>
              {t('manualConfigNeeded')}
            </span>
          )}
        </div>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{plan.provider}</span>
      </div>

      {expanded && (
        <div style={{ padding: '0 12px 12px 12px', borderTop: '1px solid var(--border)' }}>
          {plan.summary && (
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', margin: '12px 0', lineHeight: 1.6 }}>
              {plan.summary}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {plan.requirements.map((req, i) => {
              const s = strategyLabel[req.strategy] ?? { label: req.strategy, color: 'var(--ink-400)' };
              return (
                <div key={i} style={{ padding: 10, background: 'var(--bg-tertiary)', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-xs)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{req.type}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>({req.useCase})</span>
                      {req.required && (
                        <span style={{ fontSize: 10, color: 'var(--danger)' }}>REQUIRED</span>
                      )}
                    </div>
                    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 'var(--r-sm)', background: `${s.color}22`, color: s.color }}>
                      {s.label}
                    </span>
                  </div>
                  <div style={{ color: 'var(--text-secondary)', marginBottom: 6, lineHeight: 1.5 }}>{req.reasoning}</div>
                  {req.envVars.length > 0 && (
                    <div style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--text-secondary)' }}>
                      env: {req.envVars.map((e) => e.key).join(', ')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {plan.missingUserEnvVars.length > 0 && (
            <div style={{ marginTop: 10, padding: 10, background: 'var(--warn-bg)', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-xs)' }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('userMustProvide')}</div>
              {plan.missingUserEnvVars.map((v, i) => (
                <div key={i} style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--text-secondary)' }}>
                  {v.key} — {v.description}
                </div>
              ))}
            </div>
          )}
          {plan.blockers.length > 0 && (
            <div style={{ marginTop: 10, padding: 10, background: 'var(--danger-bg)', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-xs)' }}>
              <div style={{ fontWeight: 600, color: 'var(--danger)', marginBottom: 6 }}>{t('blockers')}</div>
              {plan.blockers.map((b, i) => (
                <div key={i} style={{ color: 'var(--text-secondary)' }}>{b}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SeverityBadge({ severity, count }: { severity: string; count: number }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 10px',
      borderRadius: 'var(--r-md)', fontSize: 'var(--fs-xs)', fontWeight: 600,
      background: `${SEVERITY_COLORS[severity]}20`,
      color: SEVERITY_COLORS[severity],
      border: `1px solid ${SEVERITY_COLORS[severity]}40`,
    }}>
      {count} {severity}
    </span>
  );
}

function FindingCard({ finding }: { finding: ScanFinding }) {
  const [showDetail, setShowDetail] = useState(false);
  const color = SEVERITY_COLORS[finding.severity] ?? 'var(--ink-400)';

  return (
    <div style={{
      background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
      padding: '10px 12px', cursor: 'pointer',
    }} onClick={() => setShowDetail(!showDetail)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          display: 'inline-block', padding: '1px 6px', borderRadius: 'var(--r-sm)',
          fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
          background: `${color}20`, color, border: `1px solid ${color}40`,
        }}>
          {finding.severity}
        </span>
        <span style={{
          display: 'inline-block', padding: '1px 6px', borderRadius: 'var(--r-sm)',
          fontSize: 10, background: 'var(--bg-secondary)', color: 'var(--text-secondary)',
          border: '1px solid var(--border)',
        }}>
          {finding.tool}
        </span>
        <span style={{ fontSize: 'var(--fs-xs)', fontWeight: 500, color: 'var(--text-primary)', flex: 1 }}>
          {finding.title}
        </span>
        {finding.action === 'auto_fix' && (
          <span style={{ fontSize: 10, color: 'var(--status-live)', fontWeight: 600 }}>AUTO-FIXED</span>
        )}
      </div>
      {showDetail && (
        <div style={{ marginTop: 8, fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          <p style={{ margin: '0 0 4px' }}>{finding.description}</p>
          {finding.filePath && (
            <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--accent)' }}>
              {finding.filePath}{finding.lineStart ? `:${finding.lineStart}` : ''}
              {finding.lineEnd && finding.lineEnd !== finding.lineStart ? `-${finding.lineEnd}` : ''}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function AutoFixCard({ fix }: { fix: AutoFixRecord }) {
  const [showDiff, setShowDiff] = useState(false);
  const t = useTranslations('projectDetail.scanReport');
  const isApplied = fix.applied !== false;
  const statusColor = isApplied ? 'var(--status-live)' : 'var(--status-critical)';
  const statusLabel = isApplied ? `\u2714 ${t('fixed')}` : `\u2718 ${t('notApplied')}`;

  return (
    <div style={{
      background: isApplied ? 'var(--ok-bg)' : 'var(--danger-bg)',
      border: `1px solid ${isApplied ? 'var(--ok)' : 'var(--danger)'}`,
      borderRadius: 'var(--r-sm)', padding: '10px 12px', cursor: 'pointer',
    }} onClick={() => setShowDiff(!showDiff)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: statusColor, fontSize: 'var(--fs-xs)', fontWeight: 600, flexShrink: 0 }}>{statusLabel}</span>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-primary)', flex: 1 }}>{fix.explanation}</span>
        {fix.filePath && (
          <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--text-secondary)', flexShrink: 0 }}>{fix.filePath}</span>
        )}
      </div>
      {showDiff && (fix.originalCode || fix.diff) && (
        <div style={{ marginTop: 8 }}>
          {fix.originalCode && fix.fixedCode ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div>
                <label style={{ display: 'block', fontSize: 10, color: 'var(--status-critical)', marginBottom: 2, fontWeight: 600 }}>BEFORE</label>
                <pre style={{
                  background: 'var(--danger-bg)', border: '1px solid var(--danger)', borderRadius: 'var(--r-sm)',
                  padding: 8, fontSize: 11, margin: 0, overflowX: 'auto', whiteSpace: 'pre-wrap',
                  color: 'var(--text-secondary)', maxHeight: 200,
                }}>{fix.originalCode}</pre>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 10, color: 'var(--status-live)', marginBottom: 2, fontWeight: 600 }}>AFTER</label>
                <pre style={{
                  background: 'var(--ok-bg)', border: '1px solid var(--ok)', borderRadius: 'var(--r-sm)',
                  padding: 8, fontSize: 11, margin: 0, overflowX: 'auto', whiteSpace: 'pre-wrap',
                  color: 'var(--text-secondary)', maxHeight: 200,
                }}>{fix.fixedCode}</pre>
              </div>
            </div>
          ) : fix.diff ? (
            <pre style={{
              background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
              padding: 8, fontSize: 11, margin: 0, overflowX: 'auto', whiteSpace: 'pre-wrap',
              color: 'var(--text-secondary)', maxHeight: 200,
            }}>{fix.diff}</pre>
          ) : null}
        </div>
      )}
    </div>
  );
}

/* --- Environment Variables Section --- */

interface EnvEntry {
  key: string;
  value: string;
  isNew?: boolean;
}

function EnvVarsSection({ projectId, expanded, onToggle }: {
  projectId: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [envVars, setEnvVars] = useState<{ key: string; maskedValue: string }[]>([]);
  const [loadingEnv, setLoadingEnv] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editEntries, setEditEntries] = useState<EnvEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [deleteKeys, setDeleteKeys] = useState<Set<string>>(new Set());
  const t = useTranslations('projectDetail.envVars');
  const tc = useTranslations('common');

  const loadEnvVars = () => {
    setLoadingEnv(true);
    fetch(`${API}/api/projects/${projectId}/env-vars`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        setEnvVars(d.envVars ?? []);
        setLoadingEnv(false);
      })
      .catch(() => setLoadingEnv(false));
  };

  useEffect(() => {
    if (expanded) loadEnvVars();
  }, [expanded]);

  const startEditing = () => {
    setEditEntries(envVars.map(v => ({ key: v.key, value: '', isNew: false })));
    setDeleteKeys(new Set());
    setEditing(true);
    setSaveMsg(null);
  };

  const cancelEditing = () => {
    setEditing(false);
    setEditEntries([]);
    setDeleteKeys(new Set());
    setSaveMsg(null);
  };

  const addEntry = () => {
    setEditEntries([...editEntries, { key: '', value: '', isNew: true }]);
  };

  const removeEntry = (idx: number) => {
    const entry = editEntries[idx];
    if (!entry.isNew) {
      setDeleteKeys(prev => new Set(prev).add(entry.key));
    }
    setEditEntries(editEntries.filter((_, i) => i !== idx));
  };

  const updateEntry = (idx: number, field: 'key' | 'value', val: string) => {
    const updated = [...editEntries];
    updated[idx] = { ...updated[idx], [field]: val };
    setEditEntries(updated);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg(null);

    const envVarsObj: Record<string, string> = {};
    for (const entry of editEntries) {
      if (!entry.key.trim()) continue;
      if (entry.value.trim() || entry.isNew) {
        envVarsObj[entry.key.trim()] = entry.value;
      }
    }

    if (Object.keys(envVarsObj).length === 0 && deleteKeys.size === 0) {
      setSaveMsg({ type: 'error', text: t('noChangeError') });
      setSaving(false);
      return;
    }

    try {
      const res = await fetch(`${API}/api/projects/${projectId}/env-vars`, { credentials: 'include', method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ envVars: envVarsObj }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to update');
      setSaveMsg({ type: 'success', text: t('updateSuccess', { count: String(data.updatedKeys?.length ?? 0) }) });
      setEditing(false);
      loadEnvVars();
    } catch (err) {
      setSaveMsg({ type: 'error', text: (err as Error).message });
    }
    setSaving(false);
  };

  const RESERVED_VARS = new Set(['PORT', 'K_SERVICE', 'K_REVISION', 'K_CONFIGURATION']);

  return (
    <div style={{
      background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
      padding: 16, marginTop: 16,
    }}>
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
        onClick={onToggle}
      >
        <h3 style={{ fontSize: 'var(--fs-xs)', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-secondary)', letterSpacing: 0.5, margin: 0 }}>
          {expanded ? '\u25BC' : '\u25B6'}&nbsp; {t('title')}
        </h3>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
          {envVars.length} vars
        </span>
      </div>

      {expanded && (
        <div style={{ marginTop: 12 }}>
          {loadingEnv ? (
            <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-xs)' }}>{tc('loading')}</p>
          ) : (
            <>
              {/* Action buttons */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                {!editing ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); startEditing(); }}
                    style={{
                      padding: '5px 14px', fontSize: 'var(--fs-xs)', borderRadius: 'var(--r-sm)', border: '1px solid var(--accent)',
                      background: 'transparent', color: 'var(--accent)', cursor: 'pointer',
                      fontWeight: 500,
                    }}
                  >
                    {t('editVars')}
                  </button>
                ) : (
                  <>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleSave(); }}
                      disabled={saving}
                      style={{
                        padding: '5px 14px', fontSize: 'var(--fs-xs)', borderRadius: 'var(--r-sm)', border: 'none',
                        background: 'var(--accent)', color: '#fff', cursor: saving ? 'not-allowed' : 'pointer',
                        fontWeight: 500, opacity: saving ? 0.6 : 1,
                      }}
                    >
                      {saving ? t('saving') : t('saveAndSync')}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); cancelEditing(); }}
                      style={{
                        padding: '5px 14px', fontSize: 'var(--fs-xs)', borderRadius: 'var(--r-sm)',
                        border: '1px solid var(--border)', background: 'transparent',
                        color: 'var(--text-secondary)', cursor: 'pointer',
                      }}
                    >
                      {tc('cancel')}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); addEntry(); }}
                      style={{
                        padding: '5px 14px', fontSize: 'var(--fs-xs)', borderRadius: 'var(--r-sm)',
                        border: '1px solid var(--border)', background: 'transparent',
                        color: 'var(--status-live)', cursor: 'pointer', marginLeft: 'auto',
                      }}
                    >
                      {t('addVar')}
                    </button>
                  </>
                )}
              </div>

              {/* Status message */}
              {saveMsg && (
                <div style={{
                  padding: '8px 12px', borderRadius: 'var(--r-sm)', marginBottom: 12, fontSize: 'var(--fs-xs)',
                  background: saveMsg.type === 'success' ? 'var(--ok-bg)' : 'var(--danger-bg)',
                  border: `1px solid ${saveMsg.type === 'success' ? 'var(--ok)' : 'var(--danger)'}`,
                  color: saveMsg.type === 'success' ? 'var(--status-live)' : 'var(--status-critical)',
                }}>
                  {saveMsg.text}
                </div>
              )}

              {/* Env vars table */}
              {!editing ? (
                <div style={{
                  background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
                  overflow: 'hidden',
                }}>
                  {envVars.length === 0 ? (
                    <p style={{ padding: 12, color: 'var(--text-secondary)', fontSize: 'var(--fs-xs)', margin: 0 }}>
                      No environment variables set
                    </p>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border)' }}>
                          <th style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', fontWeight: 600 }}>Key</th>
                          <th style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', fontWeight: 600 }}>Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {envVars.map((v, i) => (
                          <tr key={i} style={{ borderBottom: i < envVars.length - 1 ? '1px solid var(--border)' : 'none' }}>
                            <td style={{ padding: '6px 12px', fontFamily: 'monospace', fontSize: 'var(--fs-xs)', color: 'var(--text-primary)' }}>{v.key}</td>
                            <td style={{ padding: '6px 12px', fontFamily: 'monospace', fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>{v.maskedValue}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {editEntries.map((entry, i) => {
                    const isReserved = RESERVED_VARS.has(entry.key.toUpperCase());
                    return (
                      <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          type="text"
                          value={entry.key}
                          onChange={(e) => updateEntry(i, 'key', e.target.value)}
                          placeholder="KEY"
                          readOnly={!entry.isNew}
                          style={{
                            flex: '0 0 220px', padding: '6px 10px', fontSize: 'var(--fs-xs)', fontFamily: 'monospace',
                            background: entry.isNew ? 'var(--bg-primary)' : 'var(--bg-tertiary, var(--bg-secondary))',
                            border: `1px solid ${isReserved ? 'var(--status-critical)' : 'var(--border)'}`,
                            borderRadius: 'var(--r-sm)', color: 'var(--text-primary)',
                            opacity: entry.isNew ? 1 : 0.8,
                          }}
                        />
                        <input
                          type="text"
                          value={entry.value}
                          onChange={(e) => updateEntry(i, 'value', e.target.value)}
                          placeholder={entry.isNew ? 'value' : '(leave empty = no change)'}
                          style={{
                            flex: 1, padding: '6px 10px', fontSize: 'var(--fs-xs)', fontFamily: 'monospace',
                            background: 'var(--bg-primary)', border: '1px solid var(--border)',
                            borderRadius: 'var(--r-sm)', color: 'var(--text-primary)',
                          }}
                        />
                        <button
                          onClick={() => removeEntry(i)}
                          title={tc('delete')}
                          style={{
                            width: 28, height: 28, borderRadius: 'var(--r-sm)', border: '1px solid var(--border)',
                            background: 'transparent', color: 'var(--status-critical)',
                            cursor: 'pointer', fontSize: 'var(--fs-xs)', display: 'flex', alignItems: 'center',
                            justifyContent: 'center', flexShrink: 0,
                          }}
                        >
                          &times;
                        </button>
                        {isReserved && (
                          <span style={{ fontSize: 10, color: 'var(--status-critical)', flexShrink: 0 }}>
                            {t('reserved')}
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {editEntries.length === 0 && (
                    <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-xs)' }}>
                      {t('addVar')}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
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
  };
  return <span className={`pill ${map[status] ?? ''}`}>{status.replace(/_/g, ' ')}</span>;
}
