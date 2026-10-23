// Seçenekler: uygulama adresi ve eklenti anahtarı chrome.storage.local'da tutulur. Adrese erişim izni (isteğe bağlı
// host izni) kaydederken istenir; adres değişirse eski adresin izni geri verilir.
const CHECK_PATH = '/api/v1/scrapers/import/check';
const form = document.getElementById('form');
const appUrlInput = document.getElementById('appUrl');
const keyInput = document.getElementById('importKey');
const status = document.getElementById('status');

function say(kind, message) {
  status.className = kind;
  status.textContent = message;
}

/** "http://localhost:8080/" → "http://localhost:8080"; uygulama bir alt yolda yayınlanıyorsa yol korunur. */
function normalizeAppUrl(raw) {
  const url = URL.parse(raw.trim());
  if (!url || !['http:', 'https:'].includes(url.protocol)) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

async function check(appUrl, importKey) {
  try {
    const response = await fetch(`${appUrl}${CHECK_PATH}`, { headers: { 'X-Import-Token': importKey } });
    const body = await response.json().catch(() => null);
    if (!response.ok) return say('error', body?.error?.message ?? `Uygulama hata verdi (HTTP ${response.status}).`);
    say('ok', `Bağlandı: ${body.display_name}. Kariyer.net ya da Indeed arama sayfasında sağ alttaki düğmeyi kullanabilirsin.`);
  } catch {
    say('error', `Uygulamaya ulaşılamadı (${appUrl}). Adres doğru mu, uygulama çalışıyor mu?`);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const appUrl = normalizeAppUrl(appUrlInput.value);
  const importKey = keyInput.value.trim();
  if (!appUrl) return say('error', 'Adres http:// ya da https:// ile başlamalı.');
  const origin = new URL(appUrl).origin;
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) return say('error', `${origin} adresine erişim izni verilmedi; aktarım bu izin olmadan yapılamaz.`);
  const previous = await chrome.storage.local.get(['appUrl']);
  const previousOrigin = previous.appUrl ? new URL(previous.appUrl).origin : null;
  if (previousOrigin && previousOrigin !== origin) await chrome.permissions.remove({ origins: [`${previousOrigin}/*`] }).catch(() => undefined);
  await chrome.storage.local.set({ appUrl, importKey });
  appUrlInput.value = appUrl;
  say('', 'Kaydedildi, deneniyor…');
  await check(appUrl, importKey);
});

document.getElementById('test').addEventListener('click', async () => {
  const { appUrl, importKey } = await chrome.storage.local.get(['appUrl', 'importKey']);
  if (!appUrl || !importKey) return say('error', 'Önce adresi ve anahtarı kaydet.');
  await check(appUrl, importKey);
});

chrome.storage.local.get(['appUrl', 'importKey']).then(({ appUrl, importKey }) => {
  if (appUrl) appUrlInput.value = appUrl;
  if (importKey) keyInput.value = importKey;
});
