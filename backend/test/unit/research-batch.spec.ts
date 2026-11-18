import { batchProgress, CompanySnapshot, fieldsFound, itemStateOf, MAX_ITEM_ATTEMPTS } from '../../src/domain/research-batch';

const empty: CompanySnapshot = { sendable: 0, manual: 0, offices: 0, employees: false, phone: false, workPolicy: false, linkedin: false, website: true };

describe('toplu firma araştırması', () => {
  it('araştırma öncesi ve sonrası karşılaştırılarak bulunan alanlar sayılır', () => {
    expect(fieldsFound(empty, { ...empty, sendable: 1, offices: 2, employees: true, phone: true })).toEqual(['email', 'office', 'employees', 'phone']);
    expect(fieldsFound(empty, { ...empty, manual: 3, workPolicy: true, linkedin: true })).toEqual(['person', 'work_policy', 'linkedin']);
    expect(fieldsFound({ ...empty, sendable: 2, phone: true }, { ...empty, sendable: 2, phone: true })).toEqual([]);
  });

  it('sonuç öğe durumuna çevrilir; yapay zekâ yoksa ertelenir, defalarca yoksa başarısız olur', () => {
    expect(itemStateOf({ status: 'succeeded' }, ['email'])).toEqual({ state: 'done', note: null });
    expect(itemStateOf({ status: 'succeeded' }, []).state).toBe('no_result');
    expect(itemStateOf({ status: 'skipped', reason: 'exhausted' }, []).state).toBe('skipped');
    expect(itemStateOf({ status: 'unavailable', reason: 'no_web_tools' }, [], 1)).toEqual({ state: 'deferred', note: expect.stringContaining('Web araması') });
    expect(itemStateOf({ status: 'unavailable' }, [], MAX_ITEM_ATTEMPTS).state).toBe('failed');
    expect(itemStateOf({ status: 'failed', reason: 'zaman aşımı' }, [])).toEqual({ state: 'failed', note: 'zaman aşımı' });
  });

  it('ilerleme özeti', () => {
    const p = batchProgress([
      { companyId: 'a', state: 'done', found: ['email', 'office'], note: null },
      { companyId: 'b', state: 'deferred', found: [], note: 'kota doldu' },
      { companyId: 'c', state: 'running', found: [], note: null },
      { companyId: 'd', state: 'skipped', found: [], note: 'yakın zamanda' },
    ]);
    expect(p).toMatchObject({ total: 4, finished: 2, deferred: 1, running: 1, done: 1, skipped: 1, deferredNote: 'kota doldu', activeCompanyIds: ['b', 'c'] });
    expect(p.found).toMatchObject({ email: 1, office: 1, phone: 0 });
  });
});
