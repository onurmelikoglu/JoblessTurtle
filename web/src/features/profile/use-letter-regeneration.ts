import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { homeApi } from '@/api/home';
import { queryKeys, useAction } from '@/api/queries';
import type { HomeLetters } from '@/api/types';
import { EXAMPLE_POLL_MS, EXAMPLE_TIMEOUT_MS, REGENERATE_POLL_MS, REGENERATE_TIMEOUT_MS } from './constants';

export type LetterTemplate = HomeLetters['templates'][number];

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });

const versionOf = (templates: LetterTemplate[], intent: string) => templates.find((template) => template.intent === intent)?.updatedAt ?? null;

/** Kalıplar arka planda yazılır; sunucu bitince haber vermediği için `updatedAt` değişene kadar liste aralıklarla yeniden okunur. */
export function useLetterRegeneration() {
  const client = useQueryClient();
  const { busy: savingExample, run: runExample } = useAction();
  const { run: runSingle } = useAction();
  const [regenerating, setRegenerating] = useState<ReadonlySet<string>>(() => new Set<string>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const mark = useCallback((intents: readonly string[], active: boolean) => {
    setRegenerating((current) => {
      const next = new Set(current);
      for (const intent of intents) {
        if (active) next.add(intent);
        else next.delete(intent);
      }
      return next;
    });
  }, []);

  const pollTemplates = useCallback(
    async (intervalMs: number, timeoutMs: number, settled: (templates: LetterTemplate[]) => boolean) => {
      const startedAt = Date.now();
      while (mounted.current && Date.now() - startedAt < timeoutMs) {
        await sleep(intervalMs);
        if (!mounted.current) return;
        const letters = await client.fetchQuery({ queryKey: queryKeys.letters, queryFn: homeApi.letters, staleTime: 0 });
        if (settled(letters.templates)) return;
      }
    },
    [client],
  );

  const regenerate = useCallback(
    async ({ intent, updatedAt: before }: Pick<LetterTemplate, 'intent' | 'updatedAt'>) => {
      mark([intent], true);
      await runSingle(
        async () => {
          await homeApi.regenerateLetter(intent);
          await pollTemplates(REGENERATE_POLL_MS, REGENERATE_TIMEOUT_MS, (templates) => versionOf(templates, intent) !== before);
        },
        { refresh: false },
      );
      mark([intent], false);
    },
    [mark, pollTemplates, runSingle],
  );

  const saveExample = useCallback(
    async (text: string, templates: LetterTemplate[]) => {
      const before = new Map(templates.map((template) => [template.intent, template.updatedAt]));
      const intents = [...before.keys()];
      const pending = new Set(intents);
      await runExample(
        async () => {
          await homeApi.saveLetterExample(text.trim() ? text : null);
          mark(intents, true);
          await pollTemplates(EXAMPLE_POLL_MS, EXAMPLE_TIMEOUT_MS, (current) => {
            const finished = current.filter((template) => pending.has(template.intent) && template.body !== null && template.updatedAt !== before.get(template.intent)).map((template) => template.intent);
            for (const intent of finished) pending.delete(intent);
            mark(finished, false);
            return pending.size === 0;
          });
          return mounted.current;
        },
        { refresh: false, success: (stillOpen) => (stillOpen ? 'Kalıpların örneğine göre yeniden oluşturuldu' : null) },
      );
      mark(intents, false);
    },
    [mark, pollTemplates, runExample],
  );

  return { regenerating, savingExample, regenerate, saveExample };
}
