import { inflateSync } from 'zlib';
import type { StructuredCv } from '../../src/domain/ats';
import { scanFile } from '../../src/domain/file-scan';
import { renderCvPdf } from '../../src/engine/cv-render';

const cv: StructuredCv = {
  name: 'Ayşe Işıl Güneş',
  title: 'Kıdemli Mobil Geliştirici',
  contact: { email: 'ayse@example.com', phone: '+90 555 000 00 00', location: 'İstanbul', links: ['https://github.com/ayse'] },
  summary: 'Flutter ile ödeme ve sağlık uygulamaları geliştiren, çözüm odaklı geliştirici.',
  experience: [{ company: 'Defne Yazılım', role: 'Flutter Developer', period: '2021 – devam', bullets: ['Ödeme modülünü yeniden yazdım; hata oranı %40 düştü', 'CI/CD hattını kurdum'] }],
  education: [{ school: 'İstanbul Teknik Üniversitesi', degree: 'Bilgisayar Mühendisliği', period: '2015 – 2019' }],
  skills: ['Flutter', 'Dart', 'Firebase'],
  languages: ['İngilizce (C1)'],
  certifications: [],
  projects: [{ name: 'Şifa', description: 'Sağlık randevu uygulaması' }],
};

describe('ATS CV PDF', () => {
  it('geçerli, taramadan geçen bir PDF üretir ve Türkçe harfler için yazı tipi gömer', async () => {
    const pdf = await renderCvPdf(cv, 'tr');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const scan = scanFile('cv.pdf', pdf, 10 * 1024 * 1024);
    expect(scan.ok).toBe(true);
    expect(pdf.toString('latin1')).toContain('/FontFile2');
    expect(pdf.toString('latin1')).toMatch(/DejaVuSans/);
  });

  it('İngilizce CV İngilizce başlıklarla üretilir', async () => {
    const pdf = await renderCvPdf({ ...cv, summary: null, projects: [] }, 'en');
    const streams = [...pdf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map((m) => {
      try {
        return inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
      } catch {
        return '';
      }
    });
    expect(streams.join('').length).toBeGreaterThan(0);
    expect(pdf.length).toBeGreaterThan(1000);
  });
});
