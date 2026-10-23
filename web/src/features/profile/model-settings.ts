import type { AiStatus, ModelOption, ModelProviderName, ModelSettings } from '@/api/types';
import { MODEL_KINDS, MODEL_PROVIDERS } from './constants';

export type ProviderChoice = 'auto' | ModelProviderName;

/** Her alan için sırayla: türe özel ayar, türün varsayılanı, sağlayıcının genel ayarı, sağlayıcının genel varsayılanı. */
export function initialModels(status: AiStatus): ModelSettings {
  const draft: ModelSettings = {};
  for (const { name } of MODEL_PROVIDERS) {
    const custom = status.routing?.models?.[name] ?? status.settings.models?.[name] ?? {};
    const defaults = status.defaultModels?.[name] ?? {};
    draft[name] = Object.fromEntries(MODEL_KINDS.map((kind) => [kind, custom[kind] ?? defaults[kind] ?? custom.default ?? defaults.default ?? '']));
  }
  return draft;
}

export function filledModels(draft: ModelSettings): ModelSettings {
  const models: ModelSettings = {};
  for (const { name } of MODEL_PROVIDERS) {
    const entries = MODEL_KINDS.map((kind) => [kind, draft[name]?.[kind]?.trim() ?? ''] as const);
    models[name] = Object.fromEntries(entries.filter(([, model]) => model));
  }
  return models;
}

/** Görev türü başına sağlayıcı seçimi; kaydı olmayan görev "otomatik". */
export function initialProviders(status: AiStatus): Record<string, ProviderChoice> {
  return Object.fromEntries(MODEL_KINDS.map((kind) => [kind, status.routing?.providers?.[kind] ?? 'auto']));
}

/** Kaydedilecek seçimler: "otomatik" de gönderilir ki sunucu önceki seçimi silsin. */
export function providerPatch(draft: Record<string, ProviderChoice>): Record<string, ProviderChoice> {
  return Object.fromEntries(MODEL_KINDS.map((kind) => [kind, draft[kind] ?? 'auto']));
}

/**
 * Seçim kutusunun seçenekleri: sağlayıcının listesi, en başta "Varsayılan" (boş değer; sağlayıcı kendi varsayılanını
 * kullanır) ve listede olmayan mevcut değer (ör. sağlayıcı modeli kaldırdıysa) seçili görünsün diye en sonda.
 */
export function selectOptions(options: ModelOption[] | undefined, current: string): ModelOption[] {
  const list: ModelOption[] = [{ value: '', label: 'Varsayılan' }, ...(options ?? [])];
  if (current && !list.some((o) => o.value === current)) list.push({ value: current, label: `${current} (listede yok)` });
  return list;
}

const PROVIDER_LABEL: Record<ModelProviderName, string> = { cli_claude: 'Claude', cli_codex: 'ChatGPT' };

export const PROVIDER_CHOICES: { value: ProviderChoice; label: string }[] = [
  { value: 'auto', label: 'Otomatik' },
  { value: 'cli_claude', label: PROVIDER_LABEL.cli_claude },
  { value: 'cli_codex', label: PROVIDER_LABEL.cli_codex },
];

/** Seçimin kısa açıklaması: önce denenen sağlayıcı ve yedeği. */
export function choiceNote(choice: ProviderChoice): string {
  if (choice === 'auto') return 'Genel sıra (Claude → ChatGPT)';
  const backup: ModelProviderName = choice === 'cli_claude' ? 'cli_codex' : 'cli_claude';
  return `${PROVIDER_LABEL[choice]} önce; olmazsa ${PROVIDER_LABEL[backup]}`;
}
