'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import type { Role, User } from './types';

interface AuthState {
  user: User | null;
  status: 'loading' | 'authenticated' | 'anonymous';
  devLogin(login: string, role: Role): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthState['status']>('loading');

  useEffect(() => {
    const off = api.onSessionChange((s) => {
      setUser(s?.user ?? null);
      setStatus(s ? 'authenticated' : 'anonymous');
    });
    // Restore the session from the httpOnly refresh cookie on first load.
    void api.refresh();
    return () => {
      off();
    };
  }, []);

  const devLogin = useCallback(async (login: string, role: Role) => {
    await api.devLogin(login, role);
  }, []);
  const logout = useCallback(async () => {
    await api.logout();
  }, []);

  const value = useMemo(() => ({ user, status, devLogin, logout }), [user, status, devLogin, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
