import { adminApi } from '@/api/admin';
import { useAction } from '@/api/queries';
import type { ServerSettings } from '@/api/types';
import { Switch } from '@/ui/fields';
import { adminKeys, useAdminRefresh, useAiStatus, useServerSettings } from './admin-queries';
import { AdminInvites } from './AdminInvites';
import { AdminLetterTexts } from './AdminLetterTexts';
import { AdminUsers } from './AdminUsers';
import { DAILY_AI_LIMIT_OPTIONS, INVITEE_LIMIT_OPTIONS } from './constants';
import { Divider, LimitField, Loaded, Section } from './parts';

function InviteeSettings() {
  const settings = useServerSettings();
  const { busy, run } = useAction();
  const refreshAdmin = useAdminRefresh();

  const update = (patch: Partial<ServerSettings>, success?: string) =>
    run(
      async () => {
        await adminApi.updateSettings(patch);
        await refreshAdmin(adminKeys.settings);
      },
      { refresh: false, success },
    );

  return (
    <Loaded query={settings}>
      {({ shareCliWithInvitees, inviteeDailyLimit }) => (
        <>
          <Switch
            checked={shareCliWithInvitees}
            disabled={busy}
            onChange={(value) => void update({ shareCliWithInvitees: value })}
            label="Davetliler benim Claude aboneliğimi kullanabilir"
            description="Açıkken arkadaşlarının firma araması ve yazıları da senin Claude Code girişinle otomatik yapılır ve senin günlük kullanım limitinden düşer. Anthropic tüketici koşulları hesabın başkalarınca kullanımını kısıtlar; açmadan önce koşulları kontrol et. Kapalıyken arkadaşların kopyala-yapıştır ile kendi hesaplarını kullanır."
          />
          <LimitField
            label="Davetli başına günlük AI limiti"
            hint="Her arkadaşın senin aboneliğinden günde en fazla bu kadar AI işlemi kullanabilir; kendi ayarından yükseltemez."
            value={inviteeDailyLimit}
            options={INVITEE_LIMIT_OPTIONS}
            disabled={busy}
            onChange={(value) => void update({ inviteeDailyLimit: value }, `Davetli limiti ${value} oldu`)}
          />
        </>
      )}
    </Loaded>
  );
}

function DailyAiLimit() {
  const status = useAiStatus();
  const { busy, run } = useAction();
  const refreshAdmin = useAdminRefresh();

  /** Günlük limit ana ekrandaki AI durumunu da değiştirdiği için ana ekran verileri de yenilenir. */
  const update = (value: number) =>
    run(
      async () => {
        await adminApi.updateAiSettings({ dailyTaskLimit: value });
        await refreshAdmin(adminKeys.aiStatus);
      },
      { success: `Günlük AI limiti ${value} oldu` },
    );

  return (
    <Loaded query={status}>
      {({ settings }) => (
        <LimitField
          label="Günlük AI işlem limiti"
          hint="Firma keşfi, firma analizi ve yazılar bu limitten düşer. Derin taramada firma başına bir analiz yapılır; limit dolunca AI ertesi güne kadar durur."
          value={settings.dailyTaskLimit}
          options={DAILY_AI_LIMIT_OPTIONS}
          disabled={busy}
          onChange={(value) => void update(value)}
        />
      )}
    </Loaded>
  );
}

export function AdminSection() {
  return (
    <Section title="Yönetici">
      <AdminLetterTexts />
      <Divider />
      <AdminInvites />
      <Divider />
      <InviteeSettings />
      <Divider />
      <AdminUsers />
      <Divider />
      <DailyAiLimit />
    </Section>
  );
}
