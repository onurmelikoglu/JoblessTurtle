import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/ui/Button';
import { ChangePasswordDialog } from './ChangePasswordDialog';
import { Section } from './parts';

export function AccountSection() {
  const [changing, setChanging] = useState(false);
  return (
    <Section title="Hesap">
      <div>
        <Button icon={<KeyRound className="size-4" aria-hidden />} onClick={() => setChanging(true)}>
          Şifreyi değiştir
        </Button>
      </div>
      {changing && <ChangePasswordDialog onClose={() => setChanging(false)} />}
    </Section>
  );
}
