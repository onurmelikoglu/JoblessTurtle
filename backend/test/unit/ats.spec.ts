import { addedSkillsOf, atsScore, AtsProfile, cvHas, cvHaystack, lockIdentity, normalizeTerm, StructuredCv } from '../../src/domain/ats';

const cv: StructuredCv = {
  name: 'Ayşe Yılmaz',
  title: 'Mobil Uygulama Geliştirici',
  contact: { email: 'ayse@example.com', phone: '555', location: 'İstanbul', links: [] },
  summary: 'Flutter ve React.js ile 5 yıllık deneyim.',
  experience: [{ company: 'Defne Yazılım', role: 'Flutter Developer', period: '2021 – devam', bullets: ['Dart ile ödeme modülü geliştirdim', 'CI/CD hattını kurdum'] }],
  education: [{ school: 'İTÜ', degree: 'Bilgisayar Mühendisliği', period: '2015-2019' }],
  skills: ['Flutter', 'Dart', 'Firebase', 'Git'],
  languages: ['İngilizce'],
  certifications: [],
  projects: [],
};

const profile: AtsProfile = {
  hardSkills: ['Flutter', 'Dart', 'Kubernetes', 'ReactJS'],
  tools: ['Git', 'Jira'],
  softSkills: ['takım çalışması'],
  certifications: [],
  languages: ['English'],
  minYears: 3,
  education: 'Bilgisayar Mühendisliği',
  titleKeywords: ['Flutter Developer'],
};

describe('ATS oranı', () => {
  it('terimler Türkçe harf ve yaygın yazımlara göre eşleşir', () => {
    expect(normalizeTerm('React.js')).toBe('react');
    expect(normalizeTerm('İngilizce')).toBe('english');
    const haystack = cvHaystack(cv);
    expect(cvHas(haystack, 'ReactJS')).toBe(true);
    expect(cvHas(haystack, 'english')).toBe(true);
    expect(cvHas(haystack, 'CI/CD')).toBe(true);
    expect(cvHas(haystack, 'Kubernetes')).toBe(false);
  });

  it('eksik beceriler orana yansır ve listelenir', () => {
    const r = atsScore(cv, profile, 5);
    expect(r.missing).toEqual(['Kubernetes', 'Jira', 'takım çalışması']);
    expect(r.breakdown.skills).toEqual({ ratio: 0.67, weight: 45 });
    expect(r.breakdown.experience).toEqual({ ratio: 1, weight: 15 });
    expect(r.score).toBe(Math.round(((4 / 6) * 45 + 15 + 15 + 0 + 10 + 5) / 100 * 100));
  });

  it('ilanda olmayan boyut hesaba girmez; tam uyumlu CV 100 alır', () => {
    const only: AtsProfile = { ...profile, hardSkills: ['Flutter'], tools: [], softSkills: [], education: null, languages: [], minYears: null, titleKeywords: [] };
    const r = atsScore(cv, only, null);
    expect(r.score).toBe(100);
    expect(r.breakdown.experience).toBeNull();
  });

  it('deneyim yılı eksikse oransal puan; bilinmiyorsa yarım', () => {
    const years: AtsProfile = { ...profile, hardSkills: [], tools: [], softSkills: [], education: null, languages: [], titleKeywords: [], minYears: 4 };
    expect(atsScore(cv, years, 2).score).toBe(50);
    expect(atsScore(cv, years, null).score).toBe(50);
  });
});

describe('ATS iyileştirmesi kimliği korur', () => {
  it('ad, iletişim, işveren, dönem ve okul orijinalden gelir; eklenen beceriler bulunur', () => {
    const rewritten: StructuredCv = {
      ...cv,
      name: 'Başka Ad',
      contact: { email: 'x@y.z', links: [] },
      experience: [{ company: 'Defne Yazılım A.Ş.', role: 'Senior Flutter Developer', period: '2019 – devam', bullets: ['Kubernetes üzerinde Flutter web dağıttım'] }],
      education: [],
      skills: ['Flutter', 'Dart', 'Kubernetes', 'Jira'],
    };
    const locked = lockIdentity(cv, rewritten);
    expect(locked.name).toBe('Ayşe Yılmaz');
    expect(locked.contact.email).toBe('ayse@example.com');
    expect(locked.experience[0]).toMatchObject({ company: 'Defne Yazılım', period: '2021 – devam', role: 'Senior Flutter Developer', bullets: ['Kubernetes üzerinde Flutter web dağıttım'] });
    expect(locked.education).toEqual(cv.education);
    expect(addedSkillsOf(cv, locked)).toEqual(['Kubernetes', 'Jira']);
  });
});
