'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '../../lib/auth';

export default function LoginPage() {
  const { login, user, loading } = useAuth();
  const router = useRouter();
  const t = useTranslations('auth');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // If already logged in, redirect home
  if (!loading && user) {
    router.replace('/');
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      router.replace('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('loginFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    padding: '10px var(--sp-3)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-md)',
    fontSize: 'var(--fs-md)',
    fontFamily: 'inherit',
    background: 'var(--surface-1)',
    color: 'var(--ink-900)',
    width: '100%',
    outline: 'none',
    transition: 'border-color 0.12s',
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg)',
      padding: 'var(--sp-5)',
    }}>
      <form onSubmit={handleSubmit} style={{
        background: 'var(--surface-1)',
        padding: 'var(--sp-6) var(--sp-7)',
        borderRadius: 'var(--r-lg)',
        border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-md)',
        width: 420,
        maxWidth: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sp-4)',
      }}>
        <div>
          <h1 style={{
            margin: 0,
            fontSize: 'var(--fs-xl)',
            fontWeight: 700,
            letterSpacing: '-0.02em',
            color: 'var(--ink-900)',
          }}>{t('title')}</h1>
          <p style={{
            margin: '4px 0 0',
            color: 'var(--ink-500)',
            fontSize: 'var(--fs-sm)',
          }}>{t('subtitle')}</p>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 500, color: 'var(--ink-700)' }}>{t('email')}</span>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoComplete="email"
            autoFocus
            style={inputStyle}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 500, color: 'var(--ink-700)' }}>{t('password')}</span>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            style={inputStyle}
          />
        </label>

        {error && (
          <div style={{
            color: 'var(--danger)',
            background: 'var(--danger-bg)',
            padding: 'var(--sp-3) var(--sp-4)',
            borderRadius: 'var(--r-md)',
            fontSize: 'var(--fs-sm)',
            border: '1px solid var(--danger)',
          }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          className="btn btn-primary"
          disabled={submitting}
          style={{
            justifyContent: 'center',
            opacity: submitting ? 0.6 : 1,
            cursor: submitting ? 'not-allowed' : 'pointer',
          }}
        >
          {submitting ? t('signingIn') : t('signIn')}
        </button>
      </form>
    </div>
  );
}
