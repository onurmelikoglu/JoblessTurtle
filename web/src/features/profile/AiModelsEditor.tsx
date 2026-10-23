import { useId, useState } from 'react';
import { adminApi } from '@/api/admin';
import { useAction } from '@/api/queries';
import type { AiStatus, ModelSettings } from '@/api/types';
import { Button } from '@/ui/Button';
import { Field, Select } from '@/ui/fields';
import { adminKeys, useAdminRefresh } from './admin-queries';
import { MODEL_KINDS, MODEL_PROVIDERS } from './constants';
import { choiceNote, filledModels, initialModels, initialProviders, PROVIDER_CHOICES, providerPatch, type ProviderChoice, selectOptions } from './model-settings';
import { SubSection } from './parts';

interface ModelRowProps {
  kind: string;
  label: string;
  models: ModelSettings;
  choice: ProviderChoice;
  options: AiStatus['modelOptions'];
  onModel: (provider: string, kind: string, model: string) => void;
  onChoice: (kind: string, choice: ProviderChoice) => void;
}

function ModelRow({ kind, label, models, choice, options, onModel, onChoice }: ModelRowProps) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className="grid grid-cols-1 gap-x-2 gap-y-1.5 sm:grid-cols-[minmax(0,1fr)_9rem_10rem_10rem] sm:items-start">
      <p id={labelId} className="text-sm sm:pt-8">
        {label}
      </p>
      <Field label="Kullanılacak" hint={choiceNote(choice)}>
        {(props) => (
          <Select {...props} value={choice} onChange={(e) => onChoice(kind, e.target.value as ProviderChoice)}>
            {PROVIDER_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {MODEL_PROVIDERS.map((provider) => {
        const current = models[provider.name]?.[kind] ?? '';
        const list = selectOptions(options?.[provider.name], current);
        return (
          <Field key={provider.name} label={`${provider.label} modeli`} hint={list.find((o) => o.value === current)?.description}>
            {(props) => (
              <Select {...props} value={current} onChange={(e) => onModel(provider.name, kind, e.target.value)}>
                {list.map((o) => (
                  <option key={o.value || 'default'} value={o.value} title={o.description}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        );
      })}
    </div>
  );
}

/**
 * Görev türüne göre sağlayıcı ve model seçimi. Sunucu geneli ayardır: bütün kullanıcıların işlerine uygulanır. Seçilen
 * sağlayıcı önce denenir; limit ya da hata olursa diğeri devralır.
 */
export function AiModelsEditor({ status }: { status: AiStatus }) {
  const { busy, run } = useAction();
  const refreshAdmin = useAdminRefresh();
  const [models, setModels] = useState(() => initialModels(status));
  const [choices, setChoices] = useState(() => initialProviders(status));

  const setModel = (provider: string, kind: string, model: string) => setModels((current) => ({ ...current, [provider]: { ...current[provider], [kind]: model } }));
  const setChoice = (kind: string, choice: ProviderChoice) => setChoices((current) => ({ ...current, [kind]: choice }));

  const save = () =>
    run(
      async () => {
        await adminApi.updateAiRouting({ providers: providerPatch(choices), models: filledModels(models) });
        await refreshAdmin(adminKeys.aiStatus);
      },
      { refresh: false, success: 'Yapay zekâ ayarları kaydedildi; bütün kullanıcılara uygulanır' },
    );

  return (
    <SubSection
      title="Görev türüne göre sağlayıcı ve modeller"
      description="Her iş için önce hangi yapay zekânın kullanılacağını ve modelini seç. Bu ayar bütün kullanıcıların işlerine uygulanır. Seçtiğin sağlayıcı limite takılır ya da hata verirse diğeri devreye girer. Hafif işler ucuz modelle, araştırma ve yazılar güçlü modelle iyi çalışır."
    >
      <div className="flex flex-col gap-4">
        {MODEL_KINDS.map((kind) => (
          <ModelRow key={kind} kind={kind} label={status.kindLabels[kind] ?? kind} models={models} choice={choices[kind] ?? 'auto'} options={status.modelOptions} onModel={setModel} onChoice={setChoice} />
        ))}
      </div>
      <div className="flex justify-end">
        <Button loading={busy} onClick={() => void save()}>
          Kaydet
        </Button>
      </div>
    </SubSection>
  );
}
