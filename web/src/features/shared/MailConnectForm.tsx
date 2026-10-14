import { ExternalLink, Link2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { errorText } from '@/api/client';
import type { SmtpAccountInput } from '@/api/types';
import { Button } from '@/ui/Button';
import { Checkbox, Field, Input } from '@/ui/fields';

interface SmtpPreset {
  host: string;
  port: number;
  secure: boolean;
  helpUrl: string;
  helpText: string;
}

const GMAIL: SmtpPreset = { host: 'smtp.gmail.com', port: 465, secure: true, helpUrl: 'https://myaccount.google.com/apppasswords', helpText: 'Google hesabında 2 adımlı doğrulama açık olmalı. Uygulama parolası sayfasında "Jobless Turtle" adıyla bir parola oluştur ve 16 haneli kodu buraya yapıştır.' };
const OUTLOOK: SmtpPreset = { host: 'smtp-mail.outlook.com', port: 587, secure: false, helpUrl: 'https://account.live.com/proofs/AppPassword', helpText: 'Microsoft hesabında uygulama parolası oluşturup buraya yapıştır.' };
const YANDEX: SmtpPreset = { host: 'smtp.yandex.com', port: 465, secure: true, helpUrl: 'https://id.yandex.com/security/app-passwords', helpText: 'Yandex ID güvenlik ayarlarından "Mail" için uygulama parolası oluştur.' };
const OUTLOOK_DOMAINS = new Set(['outlook.com', 'hotmail.com', 'live.com', 'msn.com']);
const DEFAULT_TLS_PORT = 465;

function presetFor(email: string): SmtpPreset | null {
  const domain = email.split('@').pop()?.toLowerCase() ?? '';
  if (domain === 'gmail.com' || domain === 'googlemail.com') return GMAIL;
  if (OUTLOOK_DOMAINS.has(domain)) return OUTLOOK;
  if (domain.startsWith('yandex.')) return YANDEX;
  return null;
}

interface MailConnectFormProps {
  initialEmail?: string | null;
  submitLabel?: string;
  onSubmit: (input: SmtpAccountInput) => Promise<void>;
  onCancel?: () => void;
}

/** Uygulama parolasıyla SMTP hesabı bağlar; bilinen sağlayıcılarda sunucu ayarları kendiliğinden gelir. */
export function MailConnectForm({ initialEmail, submitLabel = 'Bağla', onSubmit, onCancel }: MailConnectFormProps) {
  const [email, setEmail] = useState(initialEmail ?? '');
  const [password, setPassword] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(String(DEFAULT_TLS_PORT));
  const [secure, setSecure] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const address = email.trim();
  const preset = presetFor(address);
  const custom = !preset && address.includes('@');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!address.includes('@') || !password.trim()) return setError('Mail adresini ve uygulama parolasını gir');
    if (!preset && !host.trim()) return setError('SMTP sunucusunu gir');
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        accountEmail: address,
        smtpHost: preset?.host ?? host.trim(),
        smtpPort: preset?.port ?? (Number.parseInt(port, 10) || DEFAULT_TLS_PORT),
        smtpSecure: preset?.secure ?? secure,
        appPassword: password.replaceAll(' ', ''),
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
      <Field label="Başvuruların gönderileceği mail adresin">{(props) => <Input {...props} type="email" inputMode="email" autoComplete="email" placeholder="ad.soyad@gmail.com" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
      {preset && (
        <div className="rounded-lg bg-sunken px-3 py-2 text-sm text-ink-soft">
          <p>{preset.helpText}</p>
          <a href={preset.helpUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 font-medium text-brand hover:underline">
            Uygulama parolası oluştur <ExternalLink className="size-3.5" aria-hidden />
          </a>
        </div>
      )}
      {custom && (
        <>
          <div className="grid grid-cols-[1fr_6rem] gap-2">
            <Field label="SMTP sunucusu">{(props) => <Input {...props} placeholder="smtp.firma.com" value={host} onChange={(e) => setHost(e.target.value)} />}</Field>
            <Field label="Port">{(props) => <Input {...props} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />}</Field>
          </div>
          <Checkbox checked={secure} onChange={setSecure} label="Doğrudan TLS (465)" />
        </>
      )}
      <Field label="Uygulama parolası" hint="Normal mail şifren değil. Şifreli saklanır, hiçbir ekranda gösterilmez.">
        {(props) => <Input {...props} type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />}
      </Field>
      {error && (
        <p role="alert" className="text-sm whitespace-pre-line text-bad">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Vazgeç
          </Button>
        )}
        <Button type="submit" variant="primary" loading={busy} icon={<Link2 className="size-4" aria-hidden />}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
