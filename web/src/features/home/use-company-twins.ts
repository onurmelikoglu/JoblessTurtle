import { useQuery } from '@tanstack/react-query';
import { homeApi } from '@/api/home';

const TWINS_POLL_MS = 5 * 60_000;

export const useCompanyTwins = () => useQuery({ queryKey: ['home', 'company-twins'], queryFn: homeApi.companyTwins, refetchInterval: TWINS_POLL_MS });
