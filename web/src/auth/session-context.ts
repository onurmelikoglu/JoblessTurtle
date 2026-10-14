import { createContext, useContext } from 'react';
import type { AuthStatus, Me } from '@/api/types';

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
  inviteCode?: string;
}

export interface SessionValue {
  /** offline: kayıtlı oturum var ama sunucuya ulaşılamadığı için doğrulanamadı. */
  status: 'loading' | 'anonymous' | 'authenticated' | 'offline';
  me: Me | null;
  auth: AuthStatus | null;
  login: (email: string, password: string) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  retry: () => void;
}

export const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession, SessionProvider içinde kullanılmalı');
  return value;
}

export function useMe(): Me {
  const { me } = useSession();
  if (!me) throw new Error('Oturum açık değil');
  return me;
}
