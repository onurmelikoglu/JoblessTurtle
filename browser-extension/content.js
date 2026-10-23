// Jobless Turtle içerik betiği: kullanıcının açtığı arama sonuç sayfasındaki ilanları okur (extractors.js) ve arka plana
// verir. Siteye istek atmaz, gezinmez, tıklamaz, sayfaya yazmaz; yalnızca kendi düğmesini ve bildirimini gösterir.
// Doğrulama (CAPTCHA) sayfası görülürse aktarım yapılmaz; doğrulamayı kullanıcı kendisi tamamlar.
(() => {
  if (globalThis.__jtImporter) return;
  globalThis.__jtImporter = true;

  const IMPORT_HASH = 'jt-import';
  const AUTO_KEY = 'jt-import-auto';
  const DONE_KEY = 'jt-import-done';
  const PAGE_PREFIX = 'JT_PAGE ';
  const URL_WATCH_MS = 700;
  const RENDER_WAIT_MS = 800;
  const RENDER_ATTEMPTS = 10;
  const TOAST_MS = 9000;

  const session = {
    get: (key) => {
      try {
        return sessionStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      try {
        if (value === null) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, value);
      } catch {
        /* sessionStorage kapalıysa otomatik aktarım yalnızca bu sayfa için çalışır */
      }
    },
  };

  const extractorHere = () => {
    const found = Object.entries(globalThis.JT_EXTRACTORS ?? {}).find(([, e]) => location.origin === e.origin && e.path.test(location.pathname));
    return found ? { source: found[0], ...found[1] } : null;
  };

  const readPage = (extractor) => {
    const text = extractor.read();
    return typeof text === 'string' && text.startsWith(PAGE_PREFIX) ? JSON.parse(text.slice(PAGE_PREFIX.length)) : null;
  };

  // Türkçe iyelik eki sayının okunuşuna göre: 3'ü, 5'i, 6'sı, 10'u, 40'ı, 100'ü.
  const possessive = (n) => {
    const ones = ['ı', 'i', 'si', 'ü', 'ü', 'i', 'sı', 'si', 'i', 'u'];
    const tens = ['', 'u', 'si', 'u', 'ı', 'si', 'ı', 'i', 'i', 'ı'];
    if (n === 0) return "0'ı";
    if (n % 10) return `${n}'${ones[n % 10]}`;
    if (n % 100) return `${n}'${tens[(n % 100) / 10]}`;
    return `${n}'${n % 1000 ? 'ü' : 'i'}`;
  };

  // ───────────── Düğme ve bildirim (sayfanın stillerinden yalıtılmış) ─────────────

  const host = document.createElement('div');
  host.id = 'jobless-turtle-importer';
  host.style.cssText = 'all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
      button.main { border: 0; border-radius: 999px; padding: 10px 16px; background: #0E5138; color: #fff; font: 600 13px/1 inherit; font-family: inherit; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
      button.main:disabled { opacity: .7; cursor: progress; }
      .toast { max-width: 320px; padding: 10px 12px; border-radius: 10px; background: #fff; color: #1b1b1b; box-shadow: 0 6px 20px rgba(0,0,0,.2); border-left: 4px solid #0E5138; }
      .toast.warn { border-left-color: #b7791f; }
      .toast.error { border-left-color: #c53030; }
      .toast[hidden] { display: none; }
      .actions { margin-top: 6px; display: flex; gap: 10px; }
      .actions button { border: 0; padding: 0; background: none; color: #0E5138; font: 600 12px/1.2 inherit; font-family: inherit; cursor: pointer; text-decoration: underline; }
      .auto { font-size: 11px; color: #0E5138; font-weight: 600; }
    </style>
    <div class="wrap">
      <div class="toast" hidden><div class="text"></div><div class="actions"></div></div>
      <button class="main" type="button">Jobless Turtle'a aktar</button>
    </div>`;
  const button = root.querySelector('button.main');
  const toast = root.querySelector('.toast');
  let toastTimer = null;

  const autoOn = () => session.get(AUTO_KEY) === '1';

  function show(kind, message, actions = []) {
    clearTimeout(toastTimer);
    toast.className = `toast ${kind}`;
    toast.querySelector('.text').textContent = message;
    const bar = toast.querySelector('.actions');
    bar.replaceChildren(
      ...actions.map(([label, onClick]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.addEventListener('click', onClick);
        return b;
      }),
    );
    if (autoOn()) {
      const note = document.createElement('span');
      note.className = 'auto';
      note.textContent = 'Otomatik aktarım açık';
      const off = document.createElement('button');
      off.type = 'button';
      off.textContent = 'Kapat';
      off.addEventListener('click', () => {
        session.set(AUTO_KEY, null);
        show('ok', 'Otomatik aktarım bu sekmede kapatıldı.');
      });
      bar.append(note, off);
    }
    toast.hidden = false;
    toastTimer = setTimeout(() => (toast.hidden = true), TOAST_MS);
  }

  const openOptions = () => chrome.runtime.sendMessage({ type: 'jt-open-options' });

  function report(response) {
    if (!response?.ok) {
      show('error', response?.message ?? 'Aktarılamadı.', response?.code === 'not_configured' ? [['Ayarları aç', openOptions]] : []);
      return;
    }
    const r = response.result;
    if (r.status === 'verification') return show('warn', 'Sayfada doğrulama var; tamamlayınca tekrar dene.');
    if (r.status === 'failed') return show('error', `Sayfa okunamadı: ${r.message}`);
    const matched = r.forwarded ? `${possessive(r.forwarded)} profiline uyuyor` : 'profiline yeni uyan ilan yok';
    show('ok', `${r.listings_found} ilan aktarıldı, ${matched}.`);
  }

  // ───────────── Aktarım ─────────────

  let busy = false;
  let lastSignature = null;

  /** auto: sayfa geçişinden sonra kartlar henüz çizilmediyse "empty" döner, çağıran yeniden dener. */
  async function importNow(auto) {
    const extractor = extractorHere();
    if (!extractor) {
      if (!auto) show('warn', 'Bu sayfa bir arama sonuç sayfası değil.');
      return 'skip';
    }
    if (busy) return 'busy';
    let page;
    try {
      page = readPage(extractor);
    } catch (e) {
      show('error', `Sayfa okunamadı: ${e?.message ?? e}`);
      return 'error';
    }
    if (!page) {
      show('error', 'Sayfa okunamadı.');
      return 'error';
    }
    if (!page.cards.length && page.marker) {
      show('warn', 'Sayfada doğrulama var; tamamlayınca tekrar dene.');
      return 'verification';
    }
    const signature = page.cards.length ? JSON.stringify(page.cards[0]) : null;
    if (auto && (!page.cards.length || signature === lastSignature)) return 'empty';
    busy = true;
    button.disabled = true;
    button.textContent = 'Aktarılıyor…';
    try {
      const response = await chrome.runtime.sendMessage({ type: 'jt-import', source: extractor.source, url: location.href, payload: page });
      report(response);
      if (response?.ok) lastSignature = signature;
      return response?.ok ? 'done' : 'error';
    } catch (e) {
      show('error', `Eklentiye ulaşılamadı: ${e?.message ?? e}. Sayfayı yenile.`);
      return 'error';
    } finally {
      busy = false;
      button.disabled = false;
      button.textContent = "Jobless Turtle'a aktar";
    }
  }

  const doneUrls = () => {
    try {
      return new Set(JSON.parse(session.get(DONE_KEY) ?? '[]'));
    } catch {
      return new Set();
    }
  };
  const pageKey = () => location.href.split('#')[0];

  /** Otomatik aktarım: bu sekmede her sonuç sayfası bir kez; kartlar çizilene kadar kısa aralıklarla bakılır. */
  async function autoImport() {
    const key = pageKey();
    if (!autoOn() || doneUrls().has(key)) return;
    for (let attempt = 0; attempt < RENDER_ATTEMPTS; attempt++) {
      if (pageKey() !== key) return;
      const outcome = await importNow(true);
      if (outcome === 'done') {
        session.set(DONE_KEY, JSON.stringify([...doneUrls(), key]));
        return;
      }
      if (outcome !== 'empty' && outcome !== 'busy') return;
      await new Promise((resolve) => setTimeout(resolve, RENDER_WAIT_MS));
    }
  }

  button.addEventListener('click', () => importNow(false));

  function syncVisibility() {
    host.style.display = extractorHere() ? 'block' : 'none';
  }

  if (location.hash.includes(IMPORT_HASH)) session.set(AUTO_KEY, '1');
  document.documentElement.append(host);
  syncVisibility();
  autoImport();

  // Site kendi sayfa geçişlerini (Nuxt) adresi değiştirerek yapar; içerik betiği yeniden yüklenmez.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    syncVisibility();
    autoImport();
  }, URL_WATCH_MS);
})();
