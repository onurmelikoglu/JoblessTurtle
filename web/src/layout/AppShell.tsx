import { useQuery } from '@tanstack/react-query';
import { Bell, Home, LogOut, Monitor, Moon, Sun, User, WifiOff } from 'lucide-react';
import { useSyncExternalStore, type ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { api } from '@/api/client';
import { queryKeys } from '@/api/queries';
import type { NotificationItem } from '@/api/types';
import { useMe, useSession } from '@/auth/session-context';
import { LogoMark, Wordmark } from '@/brand/Logo';
import { cn } from '@/lib/cn';
import { useTheme, type ThemeChoice } from '@/lib/theme';
import { Menu } from '@/ui/Menu';

const UNREAD_POLL_MS = 30_000;
const THEME_LABELS: Record<ThemeChoice, string> = { light: 'Açık tema', dark: 'Koyu tema', system: 'Sistem teması' };
const THEME_ICONS = { light: Sun, dark: Moon, system: Monitor };

function navClass({ isActive }: { isActive: boolean }) {
  return cn('inline-flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors duration-150', isActive ? 'bg-brand-soft text-brand-strong' : 'text-ink-soft hover:bg-sunken hover:text-ink');
}

function Header() {
  const me = useMe();
  const { logout } = useSession();
  const navigate = useNavigate();
  const { choice, setChoice } = useTheme();
  const unread = useQuery({ queryKey: [...queryKeys.notifications, 'unread'], queryFn: () => api.get<NotificationItem[]>('/v1/notifications', { unread: true }), refetchInterval: UNREAD_POLL_MS });
  const unreadCount = unread.data?.length ?? 0;
  const initial = me.user.displayName.trim().charAt(0).toLocaleUpperCase('tr') || '?';

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1120px] items-center gap-1 px-3 sm:px-5">
        <Link to="/" className="mr-auto flex items-center gap-2.5 rounded-lg py-1 pr-2" aria-label="Jobless Turtle ana sayfa">
          <LogoMark />
          <Wordmark className="text-[17px] max-[380px]:hidden" />
        </Link>
        <nav className="flex items-center gap-1" aria-label="Ana menü">
          <NavLink to="/" end className={navClass}>
            <Home className="size-4" aria-hidden />
            <span className="max-sm:sr-only">Ana sayfa</span>
          </NavLink>
          <NavLink to="/profile" className={navClass}>
            <User className="size-4" aria-hidden />
            <span className="max-sm:sr-only">Profilim</span>
          </NavLink>
          <NavLink to="/notifications" className={navClass} aria-label={unreadCount ? `Bildirimler, ${unreadCount} okunmamış` : 'Bildirimler'}>
            <Bell className="size-4" aria-hidden />
            <span className="max-md:sr-only">Bildirimler</span>
            {unreadCount > 0 && (
              <span className="min-w-5 rounded-full bg-alert px-1.5 text-center text-[11px] leading-5 font-semibold text-white" aria-hidden>
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </NavLink>
        </nav>
        <Menu
          trigger={
            <button type="button" aria-label="Hesap menüsü" className="ml-1 flex size-9 items-center justify-center rounded-full bg-brand-soft text-sm font-semibold text-brand-strong hover:bg-brand/20">
              {initial}
            </button>
          }
          items={[
            {
              heading: (
                <>
                  <span className="block text-sm font-medium text-ink">{me.user.displayName}</span>
                  {me.user.email}
                </>
              ),
            },
            'separator',
            ...(['light', 'dark', 'system'] as const).map((theme) => {
              const Icon = THEME_ICONS[theme];
              return { label: `${THEME_LABELS[theme]}${choice === theme ? ' ✓' : ''}`, icon: <Icon className="size-4" aria-hidden />, onSelect: () => setChoice(theme) };
            }),
            'separator',
            { label: 'Çıkış yap', icon: <LogOut className="size-4" aria-hidden />, onSelect: () => void logout().then(() => navigate('/login')) },
          ]}
        />
      </div>
    </header>
  );
}

function OfflineBanner() {
  const offline = useSyncExternalStore(api.subscribeOffline, api.isOffline);
  if (!offline) return null;
  return (
    <div role="alert" className="flex items-center justify-center gap-2 bg-bad-soft px-4 py-2 text-sm text-bad">
      <WifiOff className="size-4 shrink-0" aria-hidden />
      Sunucuya ulaşılamıyor. Ekrandaki bilgiler güncel olmayabilir; bağlantı gelince kendiliğinden yenilenir.
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#icerik" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:shadow">
        İçeriğe geç
      </a>
      <Header />
      <OfflineBanner />
      <main id="icerik" className="mx-auto w-full max-w-[1120px] flex-1 px-3 py-4 sm:px-5 sm:py-6">
        {children}
      </main>
    </div>
  );
}
