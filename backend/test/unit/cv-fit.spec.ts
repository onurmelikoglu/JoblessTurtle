import type { StructuredCv } from '../../src/domain/ats';
import { clampTitle, cvWords, rewriteBudget, shrinkCv, SHRINK_LEVEL_COUNT } from '../../src/domain/cv-fit';

const cv: StructuredCv = {
  name: 'Deneme Aday',
  title: 'Social Media Specialist',
  contact: { email: 'aday@aday.local', phone: null, location: 'İstanbul', links: [] },
  summary: 'Birinci cümle. İkinci cümle! Üçüncü cümle? Dördüncü cümle.',
  experience: [
    { company: 'Yeni', role: 'Specialist', period: '2023 – devam', bullets: ['a1', 'a2', 'a3', 'a4', 'a5'] },
    { company: 'Eski', role: 'Editor', period: '2019 – 2023', bullets: ['b1', 'b2', 'b3', 'b4'] },
  ],
  education: [{ school: 'Üniversite', degree: 'Lisans', period: '2015 – 2019' }],
  skills: ['Photoshop', 'Premiere', 'Excel', 'Meta Ads', 'Canva', 'Word', 'Google Ads', 'SEO', 'Figma', 'Davinci', 'Lightroom', 'Illustrator', 'After Effects', 'Notion', 'Trello', 'Slack', 'Jira'],
  languages: ['English'],
  certifications: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'],
  projects: [
    { name: 'P1', description: 'Kısa açıklama. Uzun ayrıntı.' },
    { name: 'P2', description: 'Tek cümle.' },
    { name: 'P3', description: null },
    { name: 'P4', description: 'Dört.' },
  ],
};

describe('CV sayfa sınırına sığdırma', () => {
  it('ilk düzey: deneyim başına 3 madde, en çok 12 beceri; ilanla eşleşenler kalır, önce uzun adlılar düşer', () => {
    const fitted = shrinkCv(cv, ['Jira', 'SEO'], 0)!;
    expect(fitted.experience.map((e) => e.bullets.length)).toEqual([3, 3]);
    expect(fitted.skills).toHaveLength(12);
    expect(fitted.skills).toEqual(expect.arrayContaining(['Jira', 'SEO']));
    expect(fitted.skills).not.toEqual(expect.arrayContaining(['After Effects']));
    expect(fitted.skills.indexOf('Photoshop')).toBe(0);
    expect(fitted.summary).toBe(cv.summary);
  });

  it('düzeyler ilerledikçe eski deneyim, özet, proje ve sertifikalar kısalır; kimlik ve eğitim değişmez', () => {
    const last = shrinkCv(cv, ['Jira'], SHRINK_LEVEL_COUNT - 1)!;
    expect(last.experience.map((e) => e.bullets)).toEqual([['a1', 'a2'], ['b1']]);
    expect(last.summary).toBe('Birinci cümle. İkinci cümle!');
    expect(last.projects.map((p) => p.name)).toEqual(['P1', 'P2']);
    expect(last.projects[0].description).toBe('Kısa açıklama.');
    expect(last.certifications).toEqual(['c1', 'c2']);
    expect(last.skills).toContain('Jira');
    expect(last.skills).toHaveLength(6);
    expect(last).toMatchObject({ name: cv.name, contact: cv.contact, education: cv.education });
    expect(last.experience.map((e) => [e.company, e.period])).toEqual(cv.experience.map((e) => [e.company, e.period]));
    expect(cvWords(last)).toBeLessThan(cvWords(cv));
    expect(shrinkCv(cv, [], SHRINK_LEVEL_COUNT)).toBeNull();
  });

  it('yeniden yazma bütçesi orijinal uzunluğa yakın; orijinal sınırdan uzunsa oranla küçülür', () => {
    const words = cvWords(cv);
    expect(rewriteBudget(cv, 1, 1)).toEqual({ maxPages: 1, maxWords: Math.round(words * 1.1), maxBullets: 3, maxSkills: 17, maxSkillWords: 3, maxTitleChars: 40, summarySentences: 4 });
    expect(rewriteBudget(cv, 2, 1).maxWords).toBe(Math.round(words * 1.1 * 0.5));
  });

  it('uzun unvan ilk ayraçtan kesilir; yine uzunsa orijinal unvan kalır', () => {
    const long = (title: string) => clampTitle(cv, { ...cv, title }).title;
    expect(long('Sosyal Medya Uzmanı (Social Media Specialist) | Dijital Medya Uzmanı')).toBe('Sosyal Medya Uzmanı');
    expect(long('Dijital Pazarlama Uzmanı')).toBe('Dijital Pazarlama Uzmanı');
    expect(long('Çok Uzun Tek Parça Bir Unvan Ki Hiç Ayraç İçermiyor Ve Satıra Sığmıyor')).toBe('Social Media Specialist');
  });
});
