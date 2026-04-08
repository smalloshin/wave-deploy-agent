'use client';

import { useEffect, useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

interface Settings {
  gcpProject: string;
  gcpRegion: string;
  artifactRegistry: string;
  baseDomain: string;
  cloudflareToken: string;
  cloudflareZoneId: string;
  cloudflareZoneName: string;
  slackWebhookUrl: string;
  anthropicApiKey: string;
  githubToken: string;
}

const EMPTY: Settings = {
  gcpProject: '',
  gcpRegion: '',
  artifactRegistry: '',
  baseDomain: '',
  cloudflareToken: '',
  cloudflareZoneId: '',
  cloudflareZoneName: '',
  slackWebhookUrl: '',
  anthropicApiKey: '',
  githubToken: '',
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    fetch(`${API}/api/settings`)
      .then((r) => r.json())
      .then((data) => { setSettings(data.settings); setLoading(false); })
      .catch(() => { setLoading(false); });
  }, []);

  const update = (key: keyof Settings, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`${API}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (data.success) {
        setMessage({ type: 'success', text: '設定已儲存。' });
      } else {
        setMessage({ type: 'error', text: data.message ?? '儲存設定失敗。' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: (err as Error).message });
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div>
        <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 24 }}>設定</h2>
        <div style={{ color: 'var(--text-secondary)' }}>載入設定中...</div>
      </div>
    );
  }

  return (
    <div>
      <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 24 }}>設定</h2>

      <Section title="GCP 設定">
        <Field label="GCP 專案 ID" placeholder="my-gcp-project" value={settings.gcpProject} onChange={(v) => update('gcpProject', v)} />
        <Field label="區域" placeholder="asia-east1" value={settings.gcpRegion} onChange={(v) => update('gcpRegion', v)} />
        <Field label="Artifact Registry" placeholder="asia-east1-docker.pkg.dev/project/repo" value={settings.artifactRegistry} onChange={(v) => update('artifactRegistry', v)} />
      </Section>

      <Section title="網域管理">
        <Field label="基礎網域" placeholder="deploy.yourdomain.com" value={settings.baseDomain} onChange={(v) => update('baseDomain', v)} />
        <Field label="Cloudflare Zone ID" placeholder="zone-id" value={settings.cloudflareZoneId} onChange={(v) => update('cloudflareZoneId', v)} />
        <Field label="Cloudflare Zone 名稱" placeholder="yourdomain.com" value={settings.cloudflareZoneName} onChange={(v) => update('cloudflareZoneName', v)} />
        <Field label="Cloudflare API Token" placeholder="token" type="password" value={settings.cloudflareToken} onChange={(v) => update('cloudflareToken', v)} />
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 4 }}>
          專案將部署至 [slug].yourdomain.com
        </p>
      </Section>

      <Section title="通知">
        <Field label="Slack Webhook URL" placeholder="https://hooks.slack.com/..." value={settings.slackWebhookUrl} onChange={(v) => update('slackWebhookUrl', v)} />
      </Section>

      <Section title="API 金鑰">
        <Field label="Anthropic API Key" placeholder="sk-ant-..." type="password" value={settings.anthropicApiKey} onChange={(v) => update('anthropicApiKey', v)} />
        <Field label="GitHub Token" placeholder="ghp_..." type="password" value={settings.githubToken} onChange={(v) => update('githubToken', v)} />
      </Section>

      {message && (
        <div style={{
          padding: '8px 12px', marginBottom: 12, borderRadius: 6, fontSize: 13,
          background: message.type === 'success' ? 'rgba(63,185,80,0.1)' : 'rgba(248,81,73,0.1)',
          color: message.type === 'success' ? 'var(--status-success)' : 'var(--status-critical)',
          border: `1px solid ${message.type === 'success' ? 'var(--status-success)' : 'var(--status-critical)'}`,
        }}>
          {message.text}
        </div>
      )}

      <div style={{ marginTop: 24 }}>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? '儲存中...' : '儲存設定'}
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      marginBottom: 24, padding: 16,
      background: 'var(--bg-secondary)', borderRadius: 8,
      border: '1px solid var(--border)',
    }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: 'var(--text-secondary)' }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

function Field({ label, placeholder, type = 'text', value, onChange }: {
  label: string; placeholder: string; type?: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: 13, marginBottom: 4, color: 'var(--text-secondary)' }}>
        {label}
      </label>
      <input
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%', maxWidth: 400, padding: '8px 12px',
          background: 'var(--bg-primary)', border: '1px solid var(--border)',
          borderRadius: 6, color: 'var(--text-primary)', fontSize: 14,
        }}
      />
    </div>
  );
}
