import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';
import { ServerOff } from 'lucide-react';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { useSession } from '@/auth/session-context';
import { SessionProvider } from '@/auth/SessionProvider';
import { LogoMark } from '@/brand/Logo';
import { LoginPage } from '@/features/auth/LoginPage';
import { HomePage } from '@/features/home/HomePage';
import { NotificationsPage } from '@/features/notifications/NotificationsPage';
import { ProfilePage } from '@/features/profile/ProfilePage';
import { SetupPage } from '@/features/setup/SetupPage';
import { AppShell } from '@/layout/AppShell';
import { Button } from '@/ui/Button';
import { ConfirmProvider } from '@/ui/ConfirmProvider';
import { Spinner } from '@/ui/Spinner';
import { Toaster } from '@/ui/Toaster';

const MAX_QUERY_RETRIES = 2;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      retry: (failures, error) => failures < MAX_QUERY_RETRIES && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
    },
  },
});

function FullScreen({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">{children}</div>;
}

function Protected() {
  const { status, retry } = useSession();
  if (status === 'loading') {
    return (
      <FullScreen>
        <LogoMark className="size-14" />
        <Spinner className="size-5 text-ink-soft" label="Yükleniyor" />
      </FullScreen>
    );
  }
  if (status === 'offline') {
    return (
      <FullScreen>
        <ServerOff className="size-10 text-ink-faint" aria-hidden />
        <p className="max-w-sm text-sm text-ink-soft">Sunucuya ulaşılamıyor. Bağlantını ve sunucunun çalıştığını kontrol et; oturumun açık kalır.</p>
        <Button variant="primary" onClick={retry}>
          Tekrar dene
        </Button>
      </FullScreen>
    );
  }
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={250}>
        <ConfirmProvider>
          <BrowserRouter>
            <SessionProvider>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route element={<Protected />}>
                  <Route index element={<HomePage />} />
                  <Route path="/profile" element={<ProfilePage />} />
                  <Route path="/setup" element={<SetupPage />} />
                  <Route path="/notifications" element={<NotificationsPage />} />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </SessionProvider>
          </BrowserRouter>
          <Toaster />
        </ConfirmProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
