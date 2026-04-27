'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { checkUserPermission } from '@deploy-agent/shared';
import type { Permission } from '@deploy-agent/shared';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface CurrentUser {
  id: string;
  email: string;
  display_name: string | null;
  role_name: string;
  // Round 38: tightened to Permission[] (was string[]) to match the
  // server's GET /api/auth/me response shape and let checkUserPermission
  // accept this object directly.
  permissions: Permission[];
  via: 'session' | 'api_key' | 'anonymous';
}

interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  hasPermission: (p: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/auth/me`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setUser(data);
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? 'Login failed');
    }
    await refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await fetch(`${API}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });
    setUser(null);
  }, []);

  // Round 38: delegate to shared pure helper so server (apps/api auth-service)
  // and client (this file) can never drift on the wildcard / membership rule.
  // Cast `p` to Permission: callers may pass a string literal that's not yet
  // in the union (e.g. permission added via API key), but the runtime check
  // is just `Array.includes` and tolerates any string.
  const hasPermission = useCallback((p: string) => {
    return checkUserPermission(user, p as Permission);
  }, [user]);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refresh, hasPermission }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside <AuthProvider>');
  return ctx;
}
