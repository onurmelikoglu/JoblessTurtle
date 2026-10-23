import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { aiSetupApi } from '@/api/ai-setup';
import { extensionApi } from '@/api/extension';
import { POLL_MS } from '@/api/queries';
import { anyLoginInProgress } from './setup-model';

export const setupKeys = {
  ai: ['ai', 'setup'] as const,
  extensionKey: ['extension', 'key'] as const,
};

/** Giriş sürerken (kullanıcı başka sekmede onay veriyor) durum sık yenilenir; ChatGPT girişi kendiliğinden tamamlanır. */
const LOGIN_POLL_MS = 2_000;

export const useAiSetup = () =>
  useQuery({
    queryKey: setupKeys.ai,
    queryFn: aiSetupApi.status,
    refetchInterval: (query) => (anyLoginInProgress(query.state.data?.connections) ? LOGIN_POLL_MS : POLL_MS),
  });

export const useExtensionKey = () => useQuery({ queryKey: setupKeys.extensionKey, queryFn: extensionApi.keyStatus });

export function useRefreshAiSetup() {
  const client = useQueryClient();
  return useCallback(() => client.invalidateQueries({ queryKey: setupKeys.ai }), [client]);
}
