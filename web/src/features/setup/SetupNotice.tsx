import { Circle, CircleCheck, ListChecks } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { HomeSetup } from '@/api/types';
import { Section } from '@/features/profile/parts';
import { extensionVersion } from '@/features/shared/extension-model';
import { Notice } from '@/ui/Notice';
import { pendingSteps, setupSteps } from './setup-model';
import { useAiSetup, useExtensionKey } from './setup-queries';

const LINK = 'text-sm font-medium text-brand hover:underline';

/** Ana sayfa: zorunlu kurulum adımlarından eksik kalan varsa Kurulum ekranına yönlendirir. */
export function SetupNotice({ setup }: { setup: HomeSetup }) {
  const ai = useAiSetup();
  const pending = pendingSteps(setupSteps({ home: setup, ai: ai.data, extensionVersion: null, extensionKey: undefined }), !!ai.data);
  if (!pending.length) return null;
  return (
    <Notice
      tone="warn"
      icon={<ListChecks className="size-5 shrink-0" aria-hidden />}
      action={
        <Link to="/setup" className={LINK}>
          Kurulumu tamamla
        </Link>
      }
    >
      Kurulumda eksik kalan: {pending.map((step) => step.title.toLocaleLowerCase('tr')).join(', ')}.
    </Notice>
  );
}

/** Profilim'in başında kurulum özeti; ayrıntı ve işlemler Kurulum ekranında. */
export function SetupSection({ setup }: { setup: HomeSetup }) {
  const ai = useAiSetup();
  const extensionKey = useExtensionKey();
  const steps = setupSteps({ home: setup, ai: ai.data, extensionVersion: extensionVersion(), extensionKey: extensionKey.data });
  return (
    <Section title="Kurulum">
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {steps.map((step) => (
          <li key={step.id} className="flex items-center gap-1.5 text-sm">
            {step.done ? <CircleCheck className="size-4 shrink-0 text-good" aria-hidden /> : <Circle className="size-4 shrink-0 text-ink-faint" aria-hidden />}
            {step.title}
            <span className="sr-only">{step.done ? ': tamam' : ': eksik'}</span>
          </li>
        ))}
      </ul>
      <Link to="/setup" className={LINK}>
        Kurulum listesini aç
      </Link>
    </Section>
  );
}
