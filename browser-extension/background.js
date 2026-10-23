// Jobless Turtle eklentisinin arka planı: içerik betiğinin okuduğu sayfayı uygulamaya gönderir. Siteye istek atmaz;
// yalnızca kullanıcının seçenekler sayfasında girdiği uygulama adresine (izin verildiyse) istek atar.
importScripts('extractors.js');

const IMPORT_PATH = '/api/v1/scrapers/import';

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'jt-open-options') {
    chrome.runtime.openOptionsPage();
    return false;
  }
  if (message?.type !== 'jt-import') return false;
  importPage(message, sender).then(sendResponse, (e) => sendResponse({ ok: false, code: 'internal', message: String(e?.message ?? e) }));
  return true;
});

// Mesaj yalnızca eklentinin kendi içerik betiğinden, o sitenin sekmesinden ve arama sayfası adresiyle geldiyse gönderilir.
// Adres içerik betiğinden alınır: sitenin kendi sayfa geçişlerinde (history.pushState) sekme adresi geride kalabilir.
function senderMatches(message, sender) {
  const extractor = globalThis.JT_EXTRACTORS[message.source];
  if (!extractor || sender.id !== chrome.runtime.id || !sender.url || typeof message.url !== 'string') return false;
  const page = URL.parse(message.url);
  return !!page && new URL(sender.url).origin === extractor.origin && page.origin === extractor.origin && extractor.path.test(page.pathname);
}

async function importPage(message, sender) {
  if (!senderMatches(message, sender)) return { ok: false, code: 'bad_sender', message: 'Bu sayfa bir arama sonuç sayfası değil.' };
  const { appUrl, importKey } = await chrome.storage.local.get(['appUrl', 'importKey']);
  if (!appUrl || !importKey) return { ok: false, code: 'not_configured', message: 'Eklenti ayarlanmadı: uygulama adresini ve anahtarı gir.' };
  const origin = new URL(appUrl).origin;
  if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) return { ok: false, code: 'not_configured', message: `${origin} adresine erişim izni yok; ayarları yeniden kaydet.` };
  let response;
  try {
    response = await fetch(`${appUrl}${IMPORT_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Import-Token': importKey },
      body: JSON.stringify({ source: message.source, url: message.url, payload: message.payload }),
    });
  } catch {
    return { ok: false, code: 'network', message: `Uygulamaya ulaşılamadı (${origin}).` };
  }
  const body = await response.json().catch(() => null);
  if (response.status === 401) return { ok: false, code: 'not_configured', message: body?.error?.message ?? 'Eklenti anahtarı geçersiz.' };
  if (!response.ok) return { ok: false, code: 'http', message: body?.error?.message ?? `Uygulama hata verdi (HTTP ${response.status}).` };
  return { ok: true, result: body };
}
