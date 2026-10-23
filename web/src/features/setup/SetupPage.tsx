import { useQueryClient } from '@tanstack/react-query';
import { Circle, CircleCheck, Copy, Download, ShieldCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { extensionApi } from '@/api/extension';
import { homeApi } from '@/api/home';
import { useAction, useHomeState, useRefreshHome } from '@/api/queries';
import type { ExtensionKeyStatus, HomeSetup } from '@/api/types';
import { copyText } from '@/features/profile/clipboard';
import { QueryError } from '@/features/profile/parts';
import { EXTENSION_DOWNLOAD, EXTENSION_STEPS, extensionVersion, pairingCode } from '@/features/shared/extension-model';
import { MailConnectForm } from '@/features/shared/MailConnectForm';
import { Badge } from '@/ui/Badge';
import { Button, LinkButton } from '@/ui/Button';
import { useConfirm } from '@/ui/confirm-context';
import { LoadingBlock } from '@/ui/feedback';
import { Notice } from '@/ui/Notice';
import { Panel } from '@/ui/Panel';
import { AiConnectPanel } from './AiConnectPanel';
import { extensionOutdated, setupSteps, type SetupStep, type SetupStepId } from './setup-model';
import { setupKeys, useAiSetup, useExtensionKey } from './setup-queries';

const LINK = 'text-sm font-medium text-brand hover:underline';

function StepCard({ step, index, children }: { step: SetupStep; index: number; children?: ReactNode }) {
  return (
    <li>
      <Panel className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          {step.done ? <CircleCheck className="mt-0.5 size-6 shrink-0 text-good" aria-hidden /> : <Circle className="mt-0.5 size-6 shrink-0 text-ink-faint" aria-hidden />}
          <div className="min-w-0 flex-1">
            <h2 className="flex flex-wrap items-center gap-2 font-semibold">
              <span className="sr-only">Adım {index + 1}: </span>
              {step.title}
              <Badge tone={step.done ? 'good' : step.optional ? 'neutral' : 'warn'}>{step.done ? 'Tamam' : step.optional ? 'İsteğe bağlı' : 'Eksik'}</Badge>
            </h2>
            <p className="text-sm text-ink-soft">{step.summary}</p>
          </div>
        </div>
        {children && <div className="sm:pl-9">{children}</div>}
      </Panel>
    </li>
  );
}

function MailStep({ setup }: { setup: HomeSetup }) {
  const refreshHome = useRefreshHome();
  const candidateId = setup.candidate?.id;
  if (setup.mailAccount)
    return (
      <Link to="/profile" className={LINK}>
        Profilim'de değiştir
      </Link>
    );
  if (!candidateId) return <p className="text-sm text-ink-soft">Önce profil adımını tamamla.</p>;
  return (
    <MailConnectForm
      initialEmail={setup.candidate?.email}
      onSubmit={async (input) => {
        await homeApi.connectMail(candidateId, input);
        await refreshHome();
      }}
    />
  );
}

/** İndir ve tek tıkla eşleştirme kodu: yeni anahtar üretilip kod panoya kopyalanır (anahtar yalnızca bu anda görünür). */
function ExtensionStep({ installed, keyStatus }: { installed: string | null; keyStatus: ExtensionKeyStatus | undefined }) {
  const client = useQueryClient();
  const confirm = useConfirm();
  const { busy, run } = useAction();
  const [code, setCode] = useState<string | null>(null);
  const latest = __EXTENSION_VERSION__;

  const copyPairing = async () => {
    if (keyStatus?.exists && !(await confirm({ title: 'Yeni eşleştirme kodu üretilsin mi?', message: 'Eski kod hemen geçersiz olur; eklentisi kurulu başka tarayıcılara da yeni kodu yapıştırman gerekir.', confirmLabel: 'Yeni kod üret' }))) return;
    const created = await run(() => extensionApi.createKey(), { refresh: false });
    if (!created) return;
    const pairing = pairingCode(window.location.origin, created.key);
    setCode(pairing);
    await copyText(pairing, 'Eşleştirme kodu kopyalandı; eklenti ayarlarına yapıştır');
    await client.invalidateQueries({ queryKey: setupKeys.extensionKey });
  };

  return (
    <div className="flex flex-col gap-3">
      {extensionOutdated(installed, latest) && <p className="text-sm text-warn">Yeni sürüm var ({latest}). İndirip eski klasörün üzerine aç, sonra chrome://extensions sayfasında eklentiyi yenile.</p>}
      <div className="flex flex-wrap gap-2">
        <LinkButton variant={installed ? 'outline' : 'primary'} href={EXTENSION_DOWNLOAD} download icon={<Download className="size-4" aria-hidden />}>
          Eklentiyi indir
        </LinkButton>
        <Button loading={busy} icon={<Copy className="size-4" aria-hidden />} onClick={() => void copyPairing()}>
          Eşleştirme kodunu kopyala
        </Button>
      </div>
      {code && (
        <Notice
          icon={<ShieldCheck className="size-5 shrink-0" aria-hidden />}
          action={
            <Button size="sm" icon={<Copy className="size-4" aria-hidden />} onClick={() => void copyText(code, 'Eşleştirme kodu kopyalandı')}>
              Kopyala
            </Button>
          }
        >
          <span className="flex flex-col gap-1">
            <span>Eklenti ayarlarındaki Eşleştirme kodu alanına yapıştır. Bu sayfadan çıkınca bir daha gösterilmez.</span>
            <code className="font-mono text-xs break-all">{code}</code>
          </span>
        </Notice>
      )}
      <details>
        <summary className="cursor-pointer text-sm text-ink-soft">Nasıl kurulur?</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
          {EXTENSION_STEPS.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ol>
      </details>
    </div>
  );
}

/**
 * Kurulum: ilk girişte sihirbazdan sonra açılan, Profilim'den de ulaşılan yapılacaklar listesi. Her adım durumu ve
 * ilgili işlemle birlikte gösterilir; hesap bağlama yönetici içindir, diğer adımlar herkesin kendi hesabı içindir.
 */
export function SetupPage() {
  const home = useHomeState();
  const ai = useAiSetup();
  const extensionKey = useExtensionKey();
  const installed = extensionVersion();

  if (home.isError) return <QueryError error={home.error} onRetry={() => void home.refetch()} />;
  if (!home.data) return <LoadingBlock />;
  const setup = home.data.setup;
  const steps = setupSteps({ home: setup, ai: ai.data, extensionVersion: installed, extensionKey: extensionKey.data });
  const doneCount = steps.filter((step) => step.done).length;

  const body: Record<SetupStepId, ReactNode> = {
    profile: (
      <Link to={steps[0].done ? '/profile' : '/'} className={LINK}>
        {steps[0].done ? "Profilim'de düzenle" : 'Kurulum sihirbazını aç'}
      </Link>
    ),
    ai: ai.isError ? <QueryError error={ai.error} onRetry={() => void ai.refetch()} /> : ai.data ? <AiConnectPanel status={ai.data} /> : <LoadingBlock />,
    mail: <MailStep setup={setup} />,
    extension: <ExtensionStep installed={installed} keyStatus={extensionKey.data} />,
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Kurulum</h1>
        <p className="text-sm text-ink-soft">
          {doneCount} / {steps.length} adım tamam. Terminale gerek yok; her adımı buradan yapabilirsin.
        </p>
      </header>
      <ol className="flex flex-col gap-3">
        {steps.map((step, index) => (
          <StepCard key={step.id} step={step} index={index}>
            {body[step.id]}
          </StepCard>
        ))}
      </ol>
      <div className="flex justify-end">
        <Link to="/" className={LINK}>
          Ana sayfaya dön
        </Link>
      </div>
    </div>
  );
}
