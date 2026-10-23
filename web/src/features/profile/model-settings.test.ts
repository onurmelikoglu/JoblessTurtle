import { describe, expect, it } from 'vitest';
import type { AiStatus } from '@/api/types';
import { MODEL_KINDS } from './constants';
import { choiceNote, filledModels, initialModels, initialProviders, providerPatch, selectOptions } from './model-settings';

function status(patch: Partial<AiStatus> = {}): AiStatus {
  return {
    settings: { dailyTaskLimit: 60 },
    providers: [],
    kindLabels: {},
    defaultModels: { cli_claude: { default: 'sonnet', cv_facts: 'haiku' }, cli_codex: { company_contacts: 'gpt-6.1-sol' } },
    cooldowns: {},
    routing: { providers: { company_contacts: 'cli_codex' }, models: { cli_claude: { company_report: 'opus' } } },
    modelOptions: { cli_claude: [{ value: 'haiku', label: 'Haiku' }, { value: 'sonnet', label: 'Sonnet' }, { value: 'opus', label: 'Opus' }], cli_codex: [{ value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }] },
    ...patch,
  };
}

describe('görev türüne göre sağlayıcı ve modeller', () => {
  it('modeller önce sunucu yönlendirmesinden, yoksa varsayılandan gelir', () => {
    const models = initialModels(status());
    expect(models.cli_claude.company_report).toBe('opus');
    expect(models.cli_claude.cv_facts).toBe('haiku');
    expect(models.cli_claude.job_search).toBe('sonnet');
    expect(models.cli_codex.company_contacts).toBe('gpt-6.1-sol');
    expect(models.cli_codex.company_report).toBe('');
    expect(filledModels(models).cli_codex).toEqual({ company_contacts: 'gpt-6.1-sol' });
  });

  it('kaydı olmayan görev otomatik; kayıtta otomatik de gönderilir ki eski seçim silinsin', () => {
    const choices = initialProviders(status());
    expect(choices.company_contacts).toBe('cli_codex');
    expect(choices.company_report).toBe('auto');
    const patch = providerPatch({ ...choices, company_contacts: 'auto' });
    expect(Object.keys(patch)).toEqual([...MODEL_KINDS]);
    expect(patch.company_contacts).toBe('auto');
  });

  it('seçim kutusu: başta varsayılan, listede olmayan mevcut değer sonda', () => {
    const options = status().modelOptions.cli_codex;
    expect(selectOptions(options, 'gpt-6.1-sol').map((o) => o.value)).toEqual(['', 'gpt-6.1-sol']);
    expect(selectOptions(options, 'gpt-eski').map((o) => o.label)).toEqual(['Varsayılan', 'GPT-6.1-Sol', 'gpt-eski (listede yok)']);
    expect(selectOptions(undefined, '')).toEqual([{ value: '', label: 'Varsayılan' }]);
  });

  it('seçimin açıklaması önce denenen ve yedek sağlayıcıyı söyler', () => {
    expect(choiceNote('auto')).toBe('Genel sıra (Claude → ChatGPT)');
    expect(choiceNote('cli_codex')).toBe('ChatGPT önce; olmazsa Claude');
    expect(choiceNote('cli_claude')).toBe('Claude önce; olmazsa ChatGPT');
  });
});
