import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from '@/api/client';
import type { Tokens } from '@/api/tokens';
import type { AuthStatus, Me } from '@/api/types';
import { SessionContext, type RegisterInput, type SessionValue } from './session-context';

export function SessionProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [status, setStatus] = useState<SessionValue['status']>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [attempt, setAttempt] = useState(0);

  const clear = useCallback(() => {
    api.setTokens(null);
    client.clear();
    setMe(null);
    setStatus('anonymous');
  }, [client]);

  useEffect(() => {
    api.onUnauthorized(clear);
    return () => api.onUnauthorized(null);
  }, [clear]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [authStatus, profile] = await Promise.all([api.get<AuthStatus>('/v1/auth/status'), api.hasSession() ? api.get<Me>('/v1/me') : null]);
        if (cancelled) return;
        setAuth(authStatus);
        setMe(profile);
        setStatus(profile ? 'authenticated' : 'anonymous');
      } catch (error) {
        if (cancelled) return;
        const unreachable = error instanceof ApiError && error.status === 0;
        setStatus(unreachable && api.hasSession() ? 'offline' : 'anonymous');
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const enter = useCallback(async (tokens: Tokens) => {
    api.setTokens(tokens);
    setMe(await api.get<Me>('/v1/me'));
    setAuth((current) => (current ? { ...current, needsSetup: false } : current));
    setStatus('authenticated');
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      status,
      me,
      auth,
      login: async (email, password) => enter(await api.post<Tokens>('/v1/auth/login', { email, password })),
      register: async (input: RegisterInput) => enter(await api.post<Tokens>('/v1/auth/register', { ...input, inviteCode: input.inviteCode || undefined })),
      logout: async () => {
        const refreshToken = api.refreshToken();
        if (refreshToken) await api.post('/v1/auth/logout', { refreshToken }).catch(() => undefined);
        clear();
      },
      retry: () => {
        setStatus('loading');
        setAttempt((n) => n + 1);
      },
    }),
    [status, me, auth, enter, clear],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
