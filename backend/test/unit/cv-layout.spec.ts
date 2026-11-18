import type { StructuredCv } from '../../src/domain/ats';
import { fillLayout, layoutFonts, layoutProblem } from '../../src/domain/cv-layout';
import { chromiumPath, renderHtmlPdf } from '../../src/engine/cv-html-render';
import { parseImageList, photoCandidate } from '../../src/engine/cv-photo';

const cv: StructuredCv = {
  name: 'Deneme Aday',
  title: 'Kreatif Direktör',
  contact: { email: 'aday@example.com', phone: '+90 555 000 00 00', location: 'İstanbul', links: [] },
  summary: 'Sosyal medya yönetimi ve içerik üretimi.',
  experience: [
    { company: 'Örnek Holding', role: 'Sosyal Medya Uzmanı', period: '2024–2025', bullets: ['Kurumsal hesapları yönettim', 'Kampanya tasarladım'] },
    { company: 'Freelance', role: 'Video Kurgu', period: '2022–2024', bullets: ['Montaj ve renk düzenleme'] },
  ],
  education: [{ school: 'Dokuz Eylül Üniversitesi', degree: 'Resim', period: '2020 – 2024' }],
  skills: ['Marka Yönetimi', 'Kriz Yönetimi'],
  languages: ['İngilizce (B1)'],
  certifications: [],
  projects: [],
};

const template = `<!doctype html><html><head><style>
body{font-family:'Space Grotesk',sans-serif}.side{font-family:"Arimo", sans-serif}
.page{width:100%;min-height:297mm;display:grid;grid-template-columns:60mm 1fr}
</style></head><body><div class="page">
<aside class="side">{{#photo}}<img src="{{photo}}" alt="">{{/photo}}<h3>BECERİLER</h3><ul>{{#skills}}<li>{{.}}</li>{{/skills}}</ul><h3>HOBİLER</h3><p>Tiyatro</p></aside>
<main><h1>{{name}}</h1><p>{{title}}</p><h2>HAKKIMDA</h2><p>{{summary}}</p><h2>İŞ DENEYİMİ</h2>
{{#experience}}<section><b>{{role}}</b> <i>{{company}}</i> {{period}}<p>{{description}}</p></section>{{/experience}}
</main></div></body></html>`;

describe('CV görünüm şablonu', () => {
  it('yapısal CV’yi şablona doldurur, değerleri kaçışlar ve orijinaldeki sabit bölümleri korur', () => {
    const html = fillLayout(template, { ...cv, skills: ['<b>Figma</b>', 'A & B'] }, 'data:image/png;base64,AAA');
    expect(html).toContain('<li>&lt;b&gt;Figma&lt;/b&gt;</li>');
    expect(html).toContain('<li>A &amp; B</li>');
    expect(html).toContain('Kurumsal hesapları yönettim Kampanya tasarladım');
    expect(html).toContain('<img src="data:image/png;base64,AAA"');
    expect(html).toContain('HOBİLER');
    expect(fillLayout(template, cv, null)).not.toContain('<img');
  });

  it('şablon hem açıklama hem madde kullanıyorsa deneyim metnini bir kez basar', () => {
    const both = template.replace('<p>{{description}}</p>', '{{#description}}<p>{{description}}</p>{{/description}}{{#bullets}}<p>{{.}}</p>{{/bullets}}');
    const html = fillLayout(both, cv, null);
    expect(html.match(/Kurumsal hesapları yönettim/g)).toHaveLength(1);
    expect(html).toContain('<p>Kampanya tasarladım</p>');
  });

  it('karakter kümesi meta etiketine izin verir, diğer meta etiketlerini reddeder', () => {
    expect(layoutProblem(template.replace('<head>', "<head><meta charset='utf-8'>"), cv)).toBeNull();
    expect(layoutProblem(template.replace('<head>', '<head><meta http-equiv="refresh" content="0">'), cv)).toBe('şablon izin verilmeyen etiket içeriyor');
  });

  it('doğru şablonu kabul eder; betik, dış kaynak ya da kaçışsız etiket içereni reddeder', () => {
    expect(layoutProblem(template, cv)).toBeNull();
    expect(layoutProblem(template.replace('</body>', '<script>alert(1)</script></body>'), cv)).toBe('şablon betik içeriyor');
    expect(layoutProblem(template.replace('<h3>HOBİLER</h3>', '<img src="https://x.test/a.png">'), cv)).toBe('şablon dış kaynak yüklüyor');
    expect(layoutProblem(template.replace('{{summary}}', '{{{summary}}}'), cv)).toBe('şablon izin verilmeyen şablon etiketi içeriyor');
    expect(layoutProblem(template.replace('<img src', '<img onerror="x()" src'), cv)).toBe('şablon olay özniteliği içeriyor');
  });

  it('iyileştirmede değişen alanlar şablondan gelmiyorsa şablonu reddeder', () => {
    expect(layoutProblem(template.replace('{{#skills}}<li>{{.}}</li>{{/skills}}', 'Marka Yönetimi'), cv)).toBe('beceriler şablondan gelmiyor');
    expect(layoutProblem(template.replace('<p>{{summary}}</p>', '<p>Sabit özet</p>'), cv)).toBe('özet şablondan gelmiyor');
    expect(layoutProblem(template.replace('<p>{{description}}</p>', ''), cv)).toBe('deneyim açıklamaları şablondan gelmiyor');
    expect(layoutProblem(template.replace('{{#experience}}', '{{#experience}'), cv)).not.toBeNull();
  });

  it('yalnız gömülü listede olan yazı tiplerini bulur', () => {
    expect(layoutFonts(template)).toEqual(['Space Grotesk', 'Arimo']);
    expect(layoutFonts('<p style="font-family: Lato">x</p><p style="font-family:Comic Sans">y</p>')).toEqual(['Lato']);
  });
});

describe('CV fotoğrafı', () => {
  it('ilk sayfadaki en büyük gerçek görseli seçer; maskeleri ve simgeleri atlar', () => {
    const rows = parseImageList(`page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio
--------------------------------------------------------------------------------------------
   1     0 image      40    40  rgb     3   8  png    no        12  0    72    72  1K 1%
   1     1 image     468   261  icc     3   8  jpeg   yes       26  0   128   128 21.3K 6.0%
   1     2 smask     468   261  gray    1   8  image  no        27  0   128   128 2K 1%
   2     3 image     900   900  rgb     3   8  jpeg   no        30  0   128   128 90K 6%`);
    expect(rows).toHaveLength(4);
    expect(photoCandidate(rows)).toMatchObject({ num: 1, width: 468, height: 261 });
    expect(photoCandidate(rows.filter((r) => r.num !== 1))).toBeNull();
  });
});

const withChromium = chromiumPath() ? describe : describe.skip;

withChromium('şablonun PDF çizimi', () => {
  jest.setTimeout(60_000);

  it('doldurulmuş şablonu tek sayfalık PDF’e çevirir', async () => {
    const r = await renderHtmlPdf(fillLayout(template, cv, null), 1);
    expect(r.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(r.pages).toBe(1);
    expect(r.scale).toBe(1);
  });

  it('uzayan içeriği orijinalin sayfa sayısına sığdırmak için küçültür', async () => {
    const longer = { ...cv, summary: 'Uzun özet. '.repeat(260) };
    const r = await renderHtmlPdf(fillLayout(template, longer, null), 1);
    expect(r.scale).toBeLessThan(1);
  });
});
