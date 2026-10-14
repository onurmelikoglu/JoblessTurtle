import type { AiStatus, ModelSettings } from '@/api/types';
import { MODEL_KINDS, MODEL_PROVIDERS } from './constants';

/** Her alan için sırayla: türe özel ayar, türün varsayılanı, sağlayıcının genel ayarı, sağlayıcının genel varsayılanı. */
export function initialModels(status: AiStatus): ModelSettings {
  const draft: ModelSettings = {};
  for (const { name } of MODEL_PROVIDERS) {
    const custom = status.settings.models?.[name] ?? {};
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
