'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

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
  const t = useTranslations('settings');
  const tc = useTranslations('common');

  useEffect(() => {
    fetch(`${API}/api/settings`, { credentials: 'include' })
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
      const res = await fetch(`${API}/api/settings`, { credentials: 'include', method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (data.success) {
        setMessage({ type: 'success', text: t('settingsSaved') });
      } else {
        setMessage({ type: 'error', text: data.message ?? t('saveSettingsFailed') });
      }
    } catch (err) {
      setMessage({ type: 'error', text: (err as Error).message });
    }
    setSaving(false);
  };

  const heroStyle: React.CSSProperties = {
    fontSize: 'var(--fs-2xl)',
    fontWeight: 700,
    letterSpacing: '-0.02em',
    lineHeight: 'var(--lh-tight)',
    color: 'var(--ink-900)',
    marginBottom: 'var(--sp-5)',
  };

  if (loading) {
    return (
      <div>
        <h2 style={heroStyle}>{t('title')}</h2>
        <div style={{ color: 'var(--ink-500)', fontSize: 'var(--fs-md)' }}>{t('loadingSettings')}</div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <h2 style={heroStyle}>{t('title')}</h2>

      <Section title={t('gcpSettings')}>
        <Field label={t('gcpProjectId')} placeholder="my-gcp-project" value={settings.gcpProject} onChange={(v) => update('gcpProject', v)} />
        <Field label={t('region')} placeholder="asia-east1" value={settings.gcpRegion} onChange={(v) => update('gcpRegion', v)} />
        <Field label="Artifact Registry" placeholder="asia-east1-docker.pkg.dev/project/repo" value={settings.artifactRegistry} onChange={(v) => update('artifactRegistry', v)} />
      </Section>

      <Section title={t('domainManagement')}>
        <Field label={t('baseDomain')} placeholder="deploy.yourdomain.com" value={settings.baseDomain} onChange={(v) => update('baseDomain', v)} />
        <Field label="Cloudflare Zone ID" placeholder="zone-id" value={settings.cloudflareZoneId} onChange={(v) => update('cloudflareZoneId', v)} />
        <Field label={t('cloudflareZoneName')} placeholder="yourdomain.com" value={settings.cloudflareZoneName} onChange={(v) => update('cloudflareZoneName', v)} />
        <Field label={t('cloudflareApiToken')} placeholder="token" type="password" value={settings.cloudflareToken} onChange={(v) => update('cloudflareToken', v)} />
        <p style={{ color: 'var(--ink-500)', fontSize: 'var(--fs-sm)', marginTop: 'var(--sp-2)' }}>
          {t('domainDeployHint')}
        </p>
      </Section>

      <Section title={t('notifications')}>
        <Field label="Slack Webhook URL" placeholder="https://hooks.slack.com/..." value={settings.slackWebhookUrl} onChange={(v) => update('slackWebhookUrl', v)} />
      </Section>

      <Section title={t('apiKeys')}>
        <Field label="Anthropic API Key" placeholder="sk-ant-..." type="password" value={settings.anthropicApiKey} onChange={(v) => update('anthropicApiKey', v)} />
        <Field label="GitHub Token" placeholder="ghp_..." type="password" value={settings.githubToken} onChange={(v) => update('githubToken', v)} />
      </Section>

      {message && (
        <div style={{
          padding: 'var(--sp-3) var(--sp-4)',
          marginBottom: 'var(--sp-3)',
          borderRadius: 'var(--r-md)',
          fontSize: 'var(--fs-sm)',
          background: message.type === 'success' ? 'var(--ok-bg)' : 'var(--danger-bg)',
          color: message.type === 'success' ? 'var(--ok)' : 'var(--danger)',
          border: `1px solid ${message.type === 'success' ? 'var(--ok)' : 'var(--danger)'}`,
        }}>
          {message.text}
        </div>
      )}

      <div style={{ marginTop: 'var(--sp-5)' }}>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? t('saving') : t('saveSettings')}
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      marginBottom: 'var(--sp-5)',
      padding: 'var(--sp-5)',
      background: 'var(--surface-1)',
      borderRadius: 'var(--r-lg)',
      border: '1px solid var(--border)',
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

function Field({ label, placeholder, type = 'text', value, onChange }: {
  label: string; placeholder: string; type?: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <div style={{ marginBottom: 'var(--sp-3)' }}>
      <label style={{
        display: 'block',
        fontSize: 'var(--fs-sm)',
        fontWeight: 500,
        marginBottom: 6,
        color: 'var(--ink-700)',
      }}>
        {label}
      </label>
      <input
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%',
          maxWidth: 580,
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
  );
}
