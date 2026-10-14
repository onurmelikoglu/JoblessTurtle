import { adminApi } from '@/api/admin';
import { useAction } from '@/api/queries';
import type { AdminUser } from '@/api/types';
import { fmtDate } from '@/lib/format';
import { Button } from '@/ui/Button';
import { useConfirm } from '@/ui/confirm-context';
import { adminKeys, useAdminRefresh, useAdminUsers } from './admin-queries';
import { copyText } from './clipboard';
import { ListRow, Loaded, SubSection } from './parts';

export function AdminUsers() {
  const users = useAdminUsers();
  const confirm = useConfirm();
  const { busy, run } = useAction();
  const refreshAdmin = useAdminRefresh();

  const resetPassword = async (user: AdminUser) => {
    const confirmed = await confirm({
      title: 'Şifre sıfırlansın mı?',
      message: `${user.displayName} (${user.email}) için geçici bir şifre oluşturulacak ve açık oturumları kapatılacak.`,
      confirmLabel: 'Sıfırla',
      danger: true,
    });
    if (!confirmed) return;
    await run(
      async () => {
        const { temporaryPassword } = await adminApi.resetPassword(user.id);
        await copyText(temporaryPassword, `Geçici şifre kopyalandı: ${temporaryPassword}. Arkadaşına ilet; giriş yapınca Profilim > Hesap'tan değiştirsin.`);
        await refreshAdmin(adminKeys.users);
      },
      { refresh: false },
    );
  };

  return (
    <SubSection title="Kullanıcılar" description="Şifresini unutan arkadaşına geçici şifre oluşturabilirsin. Bugünkü AI işlemi, senin aboneliğinden düşen kullanımı gösterir.">
      <Loaded query={users}>
        {(list) => (
          <ul>
            {list.map((user) => (
              <ListRow
                key={user.id}
                as="li"
                title={`${user.displayName}${user.isAdmin ? ' (yönetici)' : ''}`}
                subtitle={`${user.email} · Son giriş ${fmtDate(user.lastSeenAt)} · Bugün ${user.aiTasksToday} AI işlemi`}
                trailing={
                  !user.isAdmin && (
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void resetPassword(user)}>
                      Şifre sıfırla
                    </Button>
                  )
                }
              />
            ))}
          </ul>
        )}
      </Loaded>
    </SubSection>
  );
}
