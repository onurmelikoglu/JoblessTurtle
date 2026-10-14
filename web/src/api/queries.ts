import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { toast } from '@/ui/toast';
import { errorText } from './client';
import { homeApi } from './home';

export const POLL_MS = 20_000;

export const queryKeys = {
  home: ['home'] as const,
  state: ['home', 'state'] as const,
  companies: ['home', 'companies'] as const,
  applications: ['home', 'applications'] as const,
  inbox: ['home', 'inbox'] as const,
  letters: ['home', 'letters'] as const,
  me: ['me'] as const,
  notifications: ['notifications'] as const,
  admin: ['admin'] as const,
};

export const useHomeState = () => useQuery({ queryKey: queryKeys.state, queryFn: homeApi.state, refetchInterval: POLL_MS });

const listOptions = (enabled: boolean) => ({ enabled, refetchInterval: POLL_MS });

export const useCompanies = (enabled: boolean) => useQuery({ queryKey: queryKeys.companies, queryFn: homeApi.companies, ...listOptions(enabled) });
export const useApplications = (enabled: boolean) => useQuery({ queryKey: queryKeys.applications, queryFn: homeApi.applications, ...listOptions(enabled) });
export const useInbox = (enabled: boolean) => useQuery({ queryKey: queryKeys.inbox, queryFn: homeApi.inbox, ...listOptions(enabled) });
export const useLetters = () => useQuery({ queryKey: queryKeys.letters, queryFn: homeApi.letters });

interface ActionOptions<T> {
  success?: string | ((result: T) => string | null);
  /** Varsayılan: işlem bitince ana ekran verileri yenilenir. */
  refresh?: boolean;
}

/**
 * Kullanıcı işlemi: çalışırken `busy`, hata olursa bildirim, başarılı olursa isteğe bağlı bildirim ve veri yenileme.
 * Hata durumunda undefined döner; çağıran taraf sonucu kontrol ederek devam eder.
 */
export function useAction() {
  const client = useQueryClient();
  const [pending, setPending] = useState(0);

  const run = useCallback(
    async <T>(fn: () => Promise<T>, options: ActionOptions<T> = {}): Promise<T | undefined> => {
      setPending((n) => n + 1);
      try {
        const result = await fn();
        if (options.refresh !== false) await client.invalidateQueries({ queryKey: queryKeys.home });
        const message = typeof options.success === 'function' ? options.success(result) : options.success;
        if (message) toast.success(message);
        return result;
      } catch (error) {
        toast.error(errorText(error));
        return undefined;
      } finally {
        setPending((n) => n - 1);
      }
    },
    [client],
  );

  return { busy: pending > 0, run };
}

export function useRefreshHome() {
  const client = useQueryClient();
  return useCallback(() => client.invalidateQueries({ queryKey: queryKeys.home }), [client]);
}
