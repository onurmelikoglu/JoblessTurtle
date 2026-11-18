import { attachmentsFor, attachmentsInLanguage, pickDocument, replacementFor } from '../../src/domain/documents';

const at = (day: number) => new Date(Date.UTC(2026, 9, day));
const doc = (id: string, type: string, language: string, day: number) => ({ id, type, language, createdAt: at(day) });

const cvTr = doc('cv-tr', 'cv', 'tr', 2);
const cvTrOld = doc('cv-tr-old', 'cv', 'tr', 1);
const cvEn = doc('cv-en', 'cv', 'en', 14);
const pfTr = doc('pf-tr', 'portfolio', 'tr', 9);
const pfEn = doc('pf-en', 'portfolio', 'en', 14);
const other = doc('other', 'other', 'tr', 3);
const all = [cvTrOld, cvTr, cvEn, pfTr, pfEn, other];

describe('belge dil sürümleri', () => {
  it('dil istenmeyen yerde daha yeni İngilizce sürüm olsa da Türkçe sürüm seçilir', () => {
    expect(pickDocument(all, 'cv')?.id).toBe('cv-tr');
    expect(attachmentsFor(all)).toEqual(['cv-tr', 'pf-tr']);
  });

  it('istenen dilde sürüm yoksa türün en güncel belgesi seçilir', () => {
    expect(attachmentsFor(all, 'en')).toEqual(['cv-en', 'pf-en']);
    expect(attachmentsFor([cvTr, pfEn], 'tr')).toEqual(['cv-tr', 'pf-en']);
    expect(pickDocument([], 'cv')).toBeNull();
  });

  it('yazı İngilizceye çevrilince ekler İngilizce sürümlere, Türkçeye dönünce Türkçe sürümlere geçer', () => {
    expect(attachmentsInLanguage([cvTr, pfTr], all, 'en')).toEqual(['cv-en', 'pf-en']);
    expect(attachmentsInLanguage([cvEn, pfEn], all, 'tr')).toEqual(['cv-tr', 'pf-tr']);
  });

  it('hedef dilde sürümü olmayan ek ve elle eklenmiş başka belge yerinde kalır', () => {
    expect(attachmentsInLanguage([cvTr, pfTr, other], [cvTr, pfTr, cvEn, other], 'en')).toEqual(['cv-en', 'pf-tr', 'other']);
  });

  it('arşivlenen ekin yerine aynı dildeki güncel sürüm konur', () => {
    expect(replacementFor({ type: 'cv', language: 'en' }, [cvTr, cvEn])?.id).toBe('cv-en');
    expect(replacementFor({ type: 'cv', language: 'tr' }, [cvTr, cvEn])?.id).toBe('cv-tr');
    expect(replacementFor({ type: 'portfolio', language: 'en' }, [pfTr])?.id).toBe('pf-tr');
  });
});

describe('ATS sürümlerinin dil değişimi', () => {
  const at = (day: number) => new Date(`2026-11-${String(day).padStart(2, '0')}T00:00:00Z`);
  const docs = [
    { id: 'tr-orig', type: 'cv', language: 'tr', createdAt: at(1), variant: 'original' },
    { id: 'tr-main', type: 'cv', language: 'tr', createdAt: at(2), variant: 'ats_main' },
    { id: 'en-orig', type: 'cv', language: 'en', createdAt: at(1), variant: 'original' },
    { id: 'en-main', type: 'cv', language: 'en', createdAt: at(3), variant: 'ats_main' },
    { id: 'en-job-x', type: 'cv', language: 'en', createdAt: at(4), variant: 'ats_job', targetJobId: 'x' },
  ];

  it('ana ATS sürümü hedef dildeki ana sürüme, orijinal orijinale geçer', () => {
    expect(attachmentsInLanguage([docs[1]], docs, 'en')).toEqual(['en-main']);
    expect(attachmentsInLanguage([docs[0]], docs, 'en')).toEqual(['en-orig']);
  });

  it('başka ilanın sürümüne geçilmez; hedef dilde aynı sürüm yoksa orijinal seçilir', () => {
    const trJob = { id: 'tr-job-y', type: 'cv', language: 'tr', createdAt: at(5), variant: 'ats_job', targetJobId: 'y' };
    expect(attachmentsInLanguage([trJob], [...docs, trJob], 'en')).toEqual(['en-orig']);
  });
});
