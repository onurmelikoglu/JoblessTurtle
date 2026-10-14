import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { errorText } from '@/api/client';
import { useSession } from '@/auth/session-context';
import { LogoMark, Wordmark } from '@/brand/Logo';
import { Button } from '@/ui/Button';
import { Field, Input } from '@/ui/fields';

const MIN_PASSWORD_LENGTH = 8;

export function LoginPage() {
  const { status, auth, login, register } = useSession();
  const navigate = useNavigate();
  const [wantsRegister, setWantsRegister] = useState(false);
  const [form, setForm] = useState({ displayName: '', email: '', password: '', inviteCode: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === 'authenticated') return <Navigate to="/" replace />;

  const firstSetup = auth?.needsSetup === true;
  const registering = wantsRegister || firstSetup;
  const needsInvite = registering && !firstSetup && auth?.registrationMode === 'invite';
  const set = (key: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (registering) await register({ email: form.email.trim(), password: form.password, displayName: form.displayName.trim(), inviteCode: form.inviteCode.trim() });
      else await login(form.email.trim(), form.password);
      navigate('/', { replace: true });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <LogoMark className="size-16" />
          <h1 className="text-2xl">
            <Wordmark />
          </h1>
          <p className="text-sm text-ink-soft">{firstSetup ? 'İlk kurulum: sunucu yöneticisi hesabını oluştur.' : registering ? 'Davet kodunla hesap oluştur.' : 'Yavaş ama kararlı: iş aramanı senin yerine sürdürür.'}</p>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6" noValidate>
          {registering && <Field label="Ad soyad">{(props) => <Input {...props} required autoComplete="name" value={form.displayName} onChange={(e) => set('displayName')(e.target.value)} />}</Field>}
          <Field label="E-posta">{(props) => <Input {...props} required type="email" inputMode="email" autoComplete="email" value={form.email} onChange={(e) => set('email')(e.target.value)} />}</Field>
          <Field label="Şifre" hint={registering ? `En az ${MIN_PASSWORD_LENGTH} karakter` : undefined}>
            {(props) => <Input {...props} required type="password" autoComplete={registering ? 'new-password' : 'current-password'} minLength={registering ? MIN_PASSWORD_LENGTH : undefined} value={form.password} onChange={(e) => set('password')(e.target.value)} />}
          </Field>
          {needsInvite && <Field label="Davet kodu">{(props) => <Input {...props} required autoComplete="off" value={form.inviteCode} onChange={(e) => set('inviteCode')(e.target.value)} />}</Field>}
          {error && (
            <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-sm whitespace-pre-line text-bad">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" loading={busy} disabled={!form.email || !form.password || (registering && !form.displayName)}>
            {registering ? 'Hesap oluştur' : 'Giriş yap'}
          </Button>
          {!firstSetup && (
            <Button variant="ghost" onClick={() => setWantsRegister((v) => !v)}>
              {wantsRegister ? 'Hesabım var, giriş yap' : 'Davet kodum var, kayıt ol'}
            </Button>
          )}
        </form>
      </div>
    </main>
  );
}
