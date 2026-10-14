import { inflateSync } from 'zlib';

/**
 * Yükleme güvenliği — doküman §16: MIME/magic-byte kontrolü, boyut sınırı ve zararlı içerik taraması.
 * ClamAV gibi harici tarayıcı eklenene kadar temel kurallar uygulanır.
 */

export const ALLOWED: Record<string, { mime: string; magic: number[][] }> = {
  pdf: { mime: 'application/pdf', magic: [[0x25, 0x50, 0x44, 0x46]] },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: [[0x50, 0x4b, 0x03, 0x04]] },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', magic: [[0x50, 0x4b, 0x03, 0x04]] },
  png: { mime: 'image/png', magic: [[0x89, 0x50, 0x4e, 0x47]] },
  jpg: { mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
  jpeg: { mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
};

export interface ScanResult {
  ok: boolean;
  mime: string | null;
  reason?: string;
}

const PDF_ACTIVE_NAME = /\/(JavaScript|JS|Launch|EmbeddedFile)(?![A-Za-z0-9])/g;
const C2PA_SUBTYPE = /\/Subtype\s*\/application(#2F|\/)c2pa\b/i;
const DICT_CONTEXT_CHARS = 300;
const PDF_STREAM_START = /stream\r?\n/g;
const MAX_OBJECT_STREAM_BYTES = 5 * 1024 * 1024;

/**
 * PDF'in nesne yapısında etkin içerik adı arar. İçerik, görsel ve yazı tipi akışları ikili veri taşıdığı için
 * taranmaz (rastgele baytlar yanlış alarm üretir); yalnızca sıkıştırılmış nesne akışları (ObjStm) açılıp taranır.
 */
export function pdfActiveContent(buf: Buffer): string | null {
  const text = buf.toString('latin1');
  const structural: string[] = [];
  let cursor = 0;
  PDF_STREAM_START.lastIndex = 0;
  for (let m = PDF_STREAM_START.exec(text); m; m = PDF_STREAM_START.exec(text)) {
    if (m.index < cursor || text.slice(m.index - 3, m.index) === 'end') continue;
    const dataStart = m.index + m[0].length;
    const dataEnd = text.indexOf('endstream', dataStart);
    if (dataEnd < 0) break;
    structural.push(text.slice(cursor, m.index));
    const dict = text.slice(Math.max(cursor, text.lastIndexOf('obj', m.index)), m.index);
    if (/\/ObjStm\b/.test(dict) && /\/FlateDecode\b/.test(dict) && dataEnd - dataStart <= MAX_OBJECT_STREAM_BYTES) {
      try {
        structural.push(inflateSync(buf.subarray(dataStart, dataEnd)).toString('latin1'));
      } catch {
        structural.push('');
      }
    }
    cursor = dataEnd + 'endstream'.length;
    PDF_STREAM_START.lastIndex = cursor;
  }
  structural.push(text.slice(cursor));
  const joined = structural.join('\n');
  for (const m of joined.matchAll(PDF_ACTIVE_NAME)) {
    if (m[1] === 'EmbeddedFile' && isContentCredential(joined, m.index ?? 0)) continue;
    return m[1];
  }
  return null;
}

/** C2PA (Content Credentials) kaydı: Adobe ve sıkıştırma araçlarının eklediği, çalıştırılamayan imzalı içerik kökeni verisi. */
function isContentCredential(text: string, at: number) {
  const start = text.lastIndexOf('<<', at);
  const end = text.indexOf('>>', at);
  const dict = text.slice(Math.max(start, at - DICT_CONTEXT_CHARS), end < 0 ? at + DICT_CONTEXT_CHARS : Math.min(end, at + DICT_CONTEXT_CHARS));
  return C2PA_SUBTYPE.test(dict);
}

export function scanFile(fileName: string, buf: Buffer, maxBytes: number): ScanResult {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  const rule = ALLOWED[ext];
  if (!rule) return { ok: false, mime: null, reason: `Desteklenmeyen dosya türü (.${ext}). PDF, DOCX, PPTX, PNG veya JPG yükleyin.` };
  if (buf.length === 0) return { ok: false, mime: rule.mime, reason: 'Dosya boş' };
  if (buf.length > maxBytes) return { ok: false, mime: rule.mime, reason: `Dosya boyutu sınırı aşıldı (${Math.round(maxBytes / 1048576)} MB)` };
  const magicOk = rule.magic.some((m) => m.every((b, i) => buf[i] === b));
  if (!magicOk) return { ok: false, mime: rule.mime, reason: 'Dosya içeriği uzantısıyla uyuşmuyor' };
  if (ext === 'pdf') {
    const active = pdfActiveContent(buf);
    if (active) return { ok: false, mime: rule.mime, reason: `PDF etkin içerik barındırıyor (${active}). Dosyayı "Yazdır → PDF olarak kaydet" ile yeniden kaydedip yükleyin.` };
  }
  if (ext === 'docx' || ext === 'pptx') {
    const s = buf.toString('latin1');
    if (s.includes('vbaProject.bin')) return { ok: false, mime: rule.mime, reason: 'Belge makro içeriyor' };
    if (!s.includes('[Content_Types].xml')) return { ok: false, mime: rule.mime, reason: 'Geçersiz Office belgesi' };
  }
  return { ok: true, mime: rule.mime };
}
