import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useCallback } from 'react';
import { adminApi } from '@/api/admin';
import { queryKeys } from '@/api/queries';
import { useMe } from '@/auth/session-context';

export const adminKeys = {
  letterStyle: [...queryKeys.admin, 'letter-style'] as const,
  settings: [...queryKeys.admin, 'settings'] as const,
  invites: [...queryKeys.admin, 'invites'] as const,
  users: [...queryKeys.admin, 'users'] as const,
  aiStatus: [...queryKeys.admin, 'ai-status'] as const,
  aiUsage: [...queryKeys.admin, 'ai-usage'] as const,
  learning: [...queryKeys.admin, 'learning'] as const,
};

function useAdminQuery<T>(queryKey: QueryKey, queryFn: () => Promise<T>) {
  const { user } = useMe();
  return useQuery({ queryKey, queryFn, enabled: user.isAdmin });
}

export const useLetterStyle = () => useAdminQuery(adminKeys.letterStyle, adminApi.letterStyle);
export const useServerSettings = () => useAdminQuery(adminKeys.settings, adminApi.settings);
export const useInvites = () => useAdminQuery(adminKeys.invites, adminApi.invites);
export const useAdminUsers = () => useAdminQuery(adminKeys.users, adminApi.users);
export const useAiStatus = () => useAdminQuery(adminKeys.aiStatus, adminApi.aiStatus);
export const useAiUsage = () => useAdminQuery(adminKeys.aiUsage, adminApi.aiUsage);
export const useLearning = () => useAdminQuery(adminKeys.learning, adminApi.learning);

export function useAdminRefresh() {
  const client = useQueryClient();
  return useCallback((queryKey: QueryKey) => client.invalidateQueries({ queryKey }), [client]);
}
