// Jobless Turtle eklentisinin arka planı: içerik betiğinin okuduğu sayfayı uygulamaya gönderir. Siteye istek atmaz;
// yalnızca kullanıcının seçenekler sayfasında girdiği uygulama adresine (izin verildiyse) istek atar.
importScripts('extractors.js');

const IMPORT_PATH = '/api/v1/scrapers/import';

const BRIDGE_ID = 'jt-app-bridge';
const MAX_OPEN_TABS = 20;
const IMPORT_HASH = '#jt-import';

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

/**
 * Uygulama köprüsü (app-bridge.js) yalnızca kayıtlı uygulama adresinde ve o adres için izin verilmişse çalışır.
 * Seçenekler kaydedilince ve eklenti kurulup güncellenince yeniden kaydedilir.
 */
async function registerAppBridge() {
  const { appUrl } = await chrome.storage.local.get(['appUrl']);
  await chrome.scripting.unregisterContentScripts({ ids: [BRIDGE_ID] }).catch(() => undefined);
  if (!appUrl) return;
  const origin = new URL(appUrl).origin;
  if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) return;
  await chrome.scripting.registerContentScripts([{ id: BRIDGE_ID, matches: [`${origin}/*`], js: ['app-bridge.js'], runAt: 'document_start', persistAcrossSessions: true }]);
}

chrome.runtime.onInstalled.addListener((details) => {
  registerAppBridge().catch(() => undefined);
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

/** Açılacak adres eklentinin okuduğu sitelerden birinin arama sonuç sayfası olmalı (extractors.js); başka bir adres açılmaz. */
function isSearchUrl(raw) {
  const url = URL.parse(raw);
  if (!url || !new RegExp(`^${IMPORT_HASH}(=[A-Za-z0-9_-]+)?$`).test(url.hash)) return false;
  return Object.values(globalThis.JT_EXTRACTORS).some((e) => url.origin === e.origin && e.path.test(url.pathname));
}

async function openTabs(message, sender) {
  const { appUrl } = await chrome.storage.local.get(['appUrl']);
  if (!appUrl || !sender.url || new URL(sender.url).origin !== new URL(appUrl).origin) return { ok: false, message: 'İstek kayıtlı uygulama adresinden gelmedi.' };
  const urls = [...new Set(message.urls)].filter(isSearchUrl).slice(0, MAX_OPEN_TABS);
  if (!urls.length) return { ok: false, message: 'Açılacak arama sayfası yok.' };
  for (const [i, url] of urls.entries()) await chrome.tabs.create({ url, active: i === 0, index: sender.tab ? sender.tab.index + 1 + i : undefined });
  return { ok: true, opened: urls.length };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'jt-open-options') {
    chrome.runtime.openOptionsPage();
    return false;
  }
  if (message?.type === 'jt-register-bridge') {
    registerAppBridge().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, message: String(e?.message ?? e) }));
    return true;
  }
  if (message?.type === 'jt-open-tabs') {
    openTabs(message, sender).then(sendResponse, (e) => sendResponse({ ok: false, message: String(e?.message ?? e) }));
    return true;
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
      body: JSON.stringify({ source: message.source, url: message.url, payload: message.payload, target: typeof message.target === 'string' ? message.target : null }),
    });
  } catch {
    return { ok: false, code: 'network', message: `Uygulamaya ulaşılamadı (${origin}).` };
  }
  const body = await response.json().catch(() => null);
  if (response.status === 401) return { ok: false, code: 'not_configured', message: body?.error?.message ?? 'Eklenti anahtarı geçersiz.' };
  if (!response.ok) return { ok: false, code: 'http', message: body?.error?.message ?? `Uygulama hata verdi (HTTP ${response.status}).` };
  return { ok: true, result: body };
}
