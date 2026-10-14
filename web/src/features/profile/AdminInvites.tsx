import { Copy, UserPlus } from 'lucide-react';
import { adminApi } from '@/api/admin';
import { useAction } from '@/api/queries';
import { fmtDate } from '@/lib/format';
import { Button, IconButton } from '@/ui/Button';
import { adminKeys, useAdminRefresh, useInvites } from './admin-queries';
import { copyText } from './clipboard';
import { VISIBLE_INVITES } from './constants';
import { ListRow, Loaded, SubSection } from './parts';

export function AdminInvites() {
  const invites = useInvites();
  const { busy, run } = useAction();
  const refreshAdmin = useAdminRefresh();

  const create = () =>
    run(
      async () => {
        const invite = await adminApi.createInvite();
        await copyText(invite.code, `Davet kodu kopyalandı: ${invite.code}`);
        await refreshAdmin(adminKeys.invites);
      },
      { refresh: false },
    );

  return (
    <SubSection title="Arkadaş daveti" description={'Her kod tek kullanımlıktır ve 14 gün geçerlidir. Arkadaşın giriş ekranında "Davet kodum var" seçeneğiyle kaydolur.'}>
      <div>
        <Button variant="tonal" icon={<UserPlus className="size-4" aria-hidden />} loading={busy} onClick={() => void create()}>
          Davet kodu oluştur
        </Button>
      </div>
      <Loaded query={invites}>
        {(list) => (
          <ul>
            {list.slice(0, VISIBLE_INVITES).map((invite) => (
              <ListRow
                key={invite.id}
                as="li"
                title={<span className="font-mono">{invite.code}</span>}
                subtitle={invite.usedAt ? `Kullanıldı · ${fmtDate(invite.usedAt)}` : `Son geçerlilik ${fmtDate(invite.expiresAt)}`}
                trailing={
                  !invite.usedAt && (
                    <IconButton label="Kopyala" size="sm" onClick={() => void copyText(invite.code)}>
                      <Copy className="size-4" aria-hidden />
                    </IconButton>
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
