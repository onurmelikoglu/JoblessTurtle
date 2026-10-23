// Jobless Turtle uygulama köprüsü: yalnızca seçeneklerde kayıtlı uygulama adresinde çalışır. Uygulamaya eklentinin
// kurulu olduğunu bildirir ve "Hepsini aç" ile gelen arama adreslerini arka plana iletir; adresleri arka plan denetler
// (yalnızca eklentinin okuduğu sitelerin arama sonuç sayfaları açılır). Sayfadaki başka hiçbir veriye dokunmaz.
(() => {
  if (globalThis.__jtAppBridge) return;
  globalThis.__jtAppBridge = true;
  document.documentElement.dataset.jtExtension = chrome.runtime.getManifest().version;

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.type !== 'jt-open-searches' || !Array.isArray(message.urls)) return;
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: 'jt-open-tabs', urls: message.urls.filter((u) => typeof u === 'string') });
    } catch (e) {
      result = { ok: false, message: `Eklentiye ulaşılamadı: ${e?.message ?? e}` };
    }
    window.postMessage({ type: 'jt-open-searches-result', id: message.id ?? null, ...result }, location.origin);
  });
})();
