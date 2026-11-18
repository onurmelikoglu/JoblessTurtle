import { AutomationService } from '../../src/engine/automation.service';
import { createHarness, Harness, resetDb } from './harness';

let h: Harness;

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    set: async (key: string, value: string, ..._opts: unknown[]) => (store.has(key) ? null : (store.set(key, value), 'OK')),
    get: async (key: string) => store.get(key) ?? null,
    del: async (key: string) => Number(store.delete(key)),
    disconnect: () => undefined,
  };
}

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  (h.worker as any).connection = fakeRedis();
});

afterAll(async () => {
  await h.close();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('zamanlayıcı', () => {
  it('bir görev hata verse de diğer görevler çalışır; kilit iş bitince bırakılır', async () => {
    jest.spyOn(h.worker as any, 'scheduleSources').mockRejectedValue(new Error('kaynak hatası'));
    const followUps = jest.spyOn(h.app.get(AutomationService), 'processFollowUps').mockResolvedValue({ drafted: 0 });
    const now = new Date('2026-11-09T10:00:00Z');
    await h.worker.schedulerTick(now);
    expect(followUps).toHaveBeenCalledTimes(1);
    await h.worker.schedulerTick(new Date(now.getTime() + 60_000));
    expect(followUps).toHaveBeenCalledTimes(1);
  });

  it('başarısız periyodik görev bir sonraki aralığı beklemeden birkaç dakika sonra yeniden denenir', async () => {
    await h.prisma.keyValue.deleteMany({ where: { key: { startsWith: 'sched:' } } });
    const followUps = jest.spyOn(h.app.get(AutomationService), 'processFollowUps').mockRejectedValueOnce(new Error('geçici hata')).mockResolvedValue({ drafted: 0 });
    const now = new Date('2026-11-10T10:00:00Z');
    await h.worker.schedulerTick(now);
    expect(followUps).toHaveBeenCalledTimes(1);
    await h.worker.schedulerTick(new Date(now.getTime() + 2 * 60_000));
    expect(followUps).toHaveBeenCalledTimes(1);
    await h.worker.schedulerTick(new Date(now.getTime() + 6 * 60_000));
    expect(followUps).toHaveBeenCalledTimes(2);
  });
});
