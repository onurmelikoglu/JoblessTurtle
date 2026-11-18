import { dirname, join } from 'path';
import PDFDocument from 'pdfkit';
import type { StructuredCv } from '../domain/ats';

/**
 * ATS dostu CV: tek sütun, düz metin, standart bölüm başlıkları; tablo, sütun, görsel ve simge yok. Türkçe harfler
 * için DejaVu Sans gömülür (PDF'in standart yazı tiplerinde ğ, ş, ı yoktur).
 */
const FONT_DIR = join(dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');
const REGULAR = join(FONT_DIR, 'DejaVuSans.ttf');
const BOLD = join(FONT_DIR, 'DejaVuSans-Bold.ttf');

const PAGE_MARGIN = 50;
const NAME_SIZE = 18;
const TITLE_SIZE = 11;
const HEADING_SIZE = 11;
const BODY_SIZE = 9.5;
const SMALL_SIZE = 9;
const HEADING_GAP = 0.6;
const SECTION_GAP = 0.8;
const BULLET_INDENT = 12;
const RULE_COLOR = '#999999';
const TEXT_COLOR = '#111111';
const MUTED_COLOR = '#444444';

type Language = 'tr' | 'en';

const HEADINGS: Record<Language, Record<'summary' | 'experience' | 'skills' | 'education' | 'projects' | 'certifications' | 'languages', string>> = {
  tr: { summary: 'ÖZET', experience: 'İŞ DENEYİMİ', skills: 'BECERİLER', education: 'EĞİTİM', projects: 'PROJELER', certifications: 'SERTİFİKALAR', languages: 'DİLLER' },
  en: { summary: 'SUMMARY', experience: 'EXPERIENCE', skills: 'SKILLS', education: 'EDUCATION', projects: 'PROJECTS', certifications: 'CERTIFICATIONS', languages: 'LANGUAGES' },
};

export function renderCvPdf(cv: StructuredCv, language: Language): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, info: { Title: `${cv.name} CV`, Author: cv.name } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('body', REGULAR);
    doc.registerFont('bold', BOLD);
    const width = doc.page.width - PAGE_MARGIN * 2;
    const h = HEADINGS[language];

    const heading = (text: string) => {
      doc.moveDown(SECTION_GAP).font('bold').fontSize(HEADING_SIZE).fillColor(TEXT_COLOR).text(text);
      const y = doc.y + 1;
      doc.moveTo(PAGE_MARGIN, y).lineTo(PAGE_MARGIN + width, y).lineWidth(0.5).strokeColor(RULE_COLOR).stroke();
      doc.moveDown(HEADING_GAP);
    };
    const body = (text: string, opts: PDFKit.Mixins.TextOptions = {}) => doc.font('body').fontSize(BODY_SIZE).fillColor(TEXT_COLOR).text(text, { width, ...opts });
    const bullet = (text: string) => doc.font('body').fontSize(BODY_SIZE).fillColor(TEXT_COLOR).text(`•  ${text}`, PAGE_MARGIN + BULLET_INDENT, undefined, { width: width - BULLET_INDENT, indent: -8 });

    doc.font('bold').fontSize(NAME_SIZE).fillColor(TEXT_COLOR).text(cv.name);
    if (cv.title) doc.font('body').fontSize(TITLE_SIZE).fillColor(MUTED_COLOR).text(cv.title);
    const contact = [cv.contact.email, cv.contact.phone, cv.contact.location, ...cv.contact.links].filter((v): v is string => !!v?.trim());
    if (contact.length) doc.moveDown(0.3).font('body').fontSize(SMALL_SIZE).fillColor(MUTED_COLOR).text(contact.join('  |  '), { width });

    if (cv.summary?.trim()) {
      heading(h.summary);
      body(cv.summary.trim());
    }
    if (cv.experience.length) {
      heading(h.experience);
      cv.experience.forEach((e, i) => {
        if (i) doc.moveDown(0.5);
        doc.x = PAGE_MARGIN;
        doc.font('bold').fontSize(BODY_SIZE + 0.5).fillColor(TEXT_COLOR).text(`${e.role} — ${e.company}`, { width });
        const meta = [e.period, e.location].filter((v): v is string => !!v?.trim()).join('  |  ');
        if (meta) doc.font('body').fontSize(SMALL_SIZE).fillColor(MUTED_COLOR).text(meta, { width });
        doc.moveDown(0.2);
        for (const b of e.bullets) bullet(b);
        doc.x = PAGE_MARGIN;
      });
    }
    if (cv.skills.length) {
      heading(h.skills);
      body(cv.skills.join(', '));
    }
    if (cv.projects.length) {
      heading(h.projects);
      for (const p of cv.projects) bullet(p.description ? `${p.name}: ${p.description}` : p.name);
      doc.x = PAGE_MARGIN;
    }
    if (cv.education.length) {
      heading(h.education);
      for (const e of cv.education) body([e.degree, e.school, e.period].filter((v): v is string => !!v?.trim()).join(' — '));
    }
    if (cv.certifications.length) {
      heading(h.certifications);
      body(cv.certifications.join(', '));
    }
    if (cv.languages.length) {
      heading(h.languages);
      body(cv.languages.join(', '));
    }
    doc.end();
  });
}
