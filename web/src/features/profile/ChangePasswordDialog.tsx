import { useId, useState, type FormEvent } from 'react';
import { adminApi } from '@/api/admin';
import { useAction } from '@/api/queries';
import { Button } from '@/ui/Button';
import { Dialog } from '@/ui/Dialog';
import { Field, Input } from '@/ui/fields';
import { MIN_PASSWORD_LENGTH } from './constants';

function problemOf(next: string, repeat: string): string | null {
  if (!next) return null;
  if (next.length < MIN_PASSWORD_LENGTH) return `Yeni şifre en az ${MIN_PASSWORD_LENGTH} karakter olmalı`;
  if (repeat && repeat !== next) return 'Yeni şifreler aynı değil';
  return null;
}

export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const formId = useId();
  const { busy, run } = useAction();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const canSubmit = !busy && current !== '' && next.length >= MIN_PASSWORD_LENGTH && next === repeat;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    const changed = await run(
      async () => {
        await adminApi.changePassword(current, next);
        return true;
      },
      { refresh: false, success: 'Şifren değiştirildi' },
    );
    if (changed) onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Şifreyi değiştir"
      size="sm"
      locked={busy}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Vazgeç
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={busy} disabled={!canSubmit}>
            Değiştir
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <Field label="Mevcut şifre">{(props) => <Input {...props} type="password" autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} />}</Field>
        <Field label="Yeni şifre">{(props) => <Input {...props} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}</Field>
        <Field label="Yeni şifre (tekrar)" error={problemOf(next, repeat)}>
          {(props) => <Input {...props} type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  );
}
