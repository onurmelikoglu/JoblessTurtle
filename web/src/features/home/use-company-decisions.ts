import { useQuery } from '@tanstack/react-query';
import { homeApi } from '@/api/home';

const DECISIONS_POLL_MS = 5 * 60_000;

export const useCompanyDecisions = () => useQuery({ queryKey: ['home', 'company-decisions'], queryFn: homeApi.companyDecisions, refetchInterval: DECISIONS_POLL_MS });
