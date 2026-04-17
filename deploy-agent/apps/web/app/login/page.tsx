'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../lib/auth';

export default function LoginPage() {
  const { login, user, loading } = useAuth();
  const router = useRouter();
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
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#f5f7fa',
    }}>
      <form onSubmit={handleSubmit} style={{
        background: 'white',
        padding: '32px 40px',
        borderRadius: 8,
        boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
        width: 400,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>Wave Deploy Agent</h1>
        <p style={{ margin: 0, color: '#666', fontSize: 14 }}>登入帳號</p>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 13 }}>Email</span>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoComplete="email"
            autoFocus
            style={{
              padding: '8px 10px',
              border: '1px solid #d0d7de',
              borderRadius: 4,
              fontSize: 14,
            }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 13 }}>密碼</span>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            style={{
              padding: '8px 10px',
              border: '1px solid #d0d7de',
              borderRadius: 4,
              fontSize: 14,
            }}
          />
        </label>

        {error && (
          <div style={{
            color: '#d1242f',
            background: '#ffebe9',
            padding: '8px 12px',
            borderRadius: 4,
            fontSize: 13,
          }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          style={{
            padding: '10px 16px',
            background: submitting ? '#94a3b8' : '#0969da',
            color: 'white',
            border: 'none',
            borderRadius: 4,
            fontSize: 14,
            cursor: submitting ? 'not-allowed' : 'pointer',
            fontWeight: 500,
          }}
        >
          {submitting ? '登入中...' : '登入'}
        </button>
      </form>
    </div>
  );
}
