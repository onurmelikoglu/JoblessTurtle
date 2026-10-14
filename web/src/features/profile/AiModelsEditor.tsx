import { useId, useState } from 'react';
import { adminApi } from '@/api/admin';
import { useAction } from '@/api/queries';
import type { AiStatus, ModelSettings } from '@/api/types';
import { Button } from '@/ui/Button';
import { Field, Input } from '@/ui/fields';
import { adminKeys, useAdminRefresh } from './admin-queries';
import { MODEL_KINDS, MODEL_PROVIDERS } from './constants';
import { filledModels, initialModels } from './model-settings';
import { SubSection } from './parts';

interface ModelRowProps {
  kind: string;
  label: string;
  models: ModelSettings;
  onChange: (provider: string, kind: string, model: string) => void;
}

function ModelRow({ kind, label, models, onChange }: ModelRowProps) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className="grid grid-cols-2 gap-x-2 gap-y-1.5 sm:grid-cols-[minmax(0,1fr)_9rem_9rem] sm:items-end">
      <p id={labelId} className="col-span-2 text-sm sm:col-span-1 sm:pb-2.5">
        {label}
      </p>
      {MODEL_PROVIDERS.map((provider) => (
        <Field key={provider.name} label={provider.label}>
          {(props) => <Input {...props} autoComplete="off" spellCheck={false} value={models[provider.name]?.[kind] ?? ''} onChange={(e) => onChange(provider.name, kind, e.target.value)} />}
        </Field>
      ))}
    </div>
  );
}

export function AiModelsEditor({ status }: { status: AiStatus }) {
  const { busy, run } = useAction();
  const refreshAdmin = useAdminRefresh();
  const [models, setModels] = useState(() => initialModels(status));

  const setModel = (provider: string, kind: string, model: string) => setModels((current) => ({ ...current, [provider]: { ...current[provider], [kind]: model } }));

  const save = () =>
    run(
      async () => {
        await adminApi.updateAiSettings({ models: filledModels(models) });
        await refreshAdmin(adminKeys.aiStatus);
      },
      { refresh: false, success: 'Model ayarları kaydedildi' },
    );

  return (
    <SubSection title="Görev türüne göre modeller" description="Hafif işler (CV okuma, unvan önerisi, iletişim araması) ucuz modelle, araştırma ve yazılar güçlü modelle çalışır. Claude için: sonnet, haiku, opus.">
      <div className="flex flex-col gap-3">
        {MODEL_KINDS.map((kind) => (
          <ModelRow key={kind} kind={kind} label={status.kindLabels[kind] ?? kind} models={models} onChange={setModel} />
        ))}
      </div>
      <div className="flex justify-end">
        <Button loading={busy} onClick={() => void save()}>
          Modelleri kaydet
        </Button>
      </div>
    </SubSection>
  );
}
