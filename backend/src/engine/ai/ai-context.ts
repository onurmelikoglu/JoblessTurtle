import { AsyncLocalStorage } from 'async_hooks';
import { AiClass } from '../../domain/ai-budget';

interface AiScope {
  aiClass: AiClass;
  calls: number;
}

const storage = new AsyncLocalStorage<AiScope>();

/**
 * İçinde yapılan yapay zekâ çağrıları görev türünden bağımsız olarak verilen öncelik sınıfında sayılır: kullanıcının
 * ekranda beklediği iş "etkileşimli", geri dönen başvuru için yapılan adres araması "düzeltme" sınıfındadır.
 * Dönen calls, kapsam içinde bir sağlayıcıya gerçekten gönderilen görev sayısıdır.
 */
export async function withAiClass<T>(aiClass: AiClass, fn: () => Promise<T>): Promise<{ value: T; calls: number }> {
  const scope: AiScope = { aiClass, calls: 0 };
  const value = await storage.run(scope, fn);
  return { value, calls: scope.calls };
}

export function currentAiClass(): AiClass | null {
  return storage.getStore()?.aiClass ?? null;
}

export function noteAiCall() {
  const scope = storage.getStore();
  if (scope) scope.calls++;
}
