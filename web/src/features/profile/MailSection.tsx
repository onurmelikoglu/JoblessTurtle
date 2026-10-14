import { CircleAlert, CircleCheck } from 'lucide-react';
import { useState } from 'react';
import { homeApi } from '@/api/home';
import { useAction, useRefreshHome } from '@/api/queries';
import type { HomeSetup, SmtpAccountInput } from '@/api/types';
import { MailConnectForm } from '@/features/shared/MailConnectForm';
import { Button } from '@/ui/Button';
import { CANDIDATE_REQUIRED, MAIL_LIMIT_OPTIONS } from './constants';
import { LimitField, ListRow, Section } from './parts';

interface MailSectionProps {
  setup: HomeSetup;
  onPolicy: (blocker: string | null) => void;
}

export function MailSection({ setup, onPolicy }: MailSectionProps) {
  const { busy, run } = useAction();
  const refreshHome = useRefreshHome();
  const [changing, setChanging] = useState(false);
  const mail = setup.mailAccount;
  const candidateId = setup.candidate?.id;

  /** Hata formun kendi satırında gösterilsin diye useAction yerine doğrudan çağrılır; form hatayı yakalayıp yazar. */
  const connect = async (input: SmtpAccountInput) => {
    if (!candidateId) throw new Error(CANDIDATE_REQUIRED);
    await homeApi.connectMail(candidateId, input);
    if (mail) await homeApi.deleteMailAccount(mail.id);
    const synced = await homeApi.syncPolicy();
    onPolicy(synced.policyBlocker);
    await refreshHome();
    setChanging(false);
  };

  if (!mail || changing) {
    return (
      <Section title="Gönderim maili">
        <MailConnectForm initialEmail={mail?.accountEmail ?? setup.candidate?.email} submitLabel={mail ? 'Değiştir' : 'Bağla'} onSubmit={connect} onCancel={changing ? () => setChanging(false) : undefined} />
      </Section>
    );
  }

  const healthy = mail.health === 'ok';
  return (
    <Section title="Gönderim maili">
      <ListRow
        leading={healthy ? <CircleCheck className="size-5 shrink-0 text-good" aria-hidden /> : <CircleAlert className="size-5 shrink-0 text-bad" aria-hidden />}
        title={mail.accountEmail}
        subtitle={healthy ? 'Başvurular bu adresten gönderiliyor' : 'Bağlantı sorunu var, yeniden bağla'}
        trailing={
          <Button size="sm" onClick={() => setChanging(true)}>
            Değiştir
          </Button>
        }
      />
      <LimitField
        label="Günlük gönderim limiti"
        hint="Bir günde gönderilecek en fazla başvuru; fazlası ertesi sabah 09:00'da gider. Mailler arasında 30-50 sn beklenir. Gmail'in kendi günlük sınırı yaklaşık 500 olduğu için 300 önerilir."
        value={mail.dailyLimit}
        options={MAIL_LIMIT_OPTIONS}
        disabled={busy}
        onChange={(value) => void run(() => homeApi.setMailLimit(value), { success: `Günlük gönderim limiti ${value} oldu` })}
      />
    </Section>
  );
}
