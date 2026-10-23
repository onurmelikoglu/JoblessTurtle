// Bu dosya üretilir; elle düzenlenmez. Kaynak: backend/src/engine/scrapers/parsers/*.browser.ts
// Yeniden üretmek için backend klasöründe: npm run extension:extractors
globalThis.JT_EXTRACTORS = {
  kariyer_net: {
    label: "Kariyer.net",
    origin: "https://www.kariyer.net",
    path: new RegExp("^\\/is-ilanlari\\/([a-z0-9+-]+?)(?:-\\d+)?\\/?$"),
    read: function () {
      return (() => {
        const S = {"listRoot":"[data-test=\"list-items\"]","card":"[data-test=\"ad-card\"]","link":"a[data-test=\"ad-card-item\"]","title":"[data-test=\"ad-card-title\"]","company":"[data-test=\"subtitle\"]","location":"[data-test=\"location\"]","workModel":"[data-test=\"work-model\"]","date":"[data-test=\"ad-date\"]"};
        const A = {"city":"cityname","workType":"worktypetext","workModel":"workmodeltext","dateStatus":"jobdatestatus","position":"positionname"};
        const MARKERS = ["px-captcha","window._pxAppId","Access to this page has been denied"];
        const html = document.documentElement.outerHTML;
        const marker = MARKERS.find((m) => html.includes(m)) || null;
        const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '') || null;
        const cards = [...document.querySelectorAll(S.card)].map((el) => {
          const link = el.querySelector(S.link);
          const date = el.querySelector(S.date);
          let dateText = null;
          if (date) {
            const copy = date.cloneNode(true);
            copy.querySelectorAll('i').forEach((i) => i.remove());
            dateText = text(copy);
          }
          return [link ? link.getAttribute('href') : null, text(el.querySelector(S.title)), text(el.querySelector(S.company)), text(el.querySelector(S.location)) || el.getAttribute(A.city), el.getAttribute(A.workType), el.getAttribute(A.workModel) || text(el.querySelector(S.workModel)), dateText, el.getAttribute(A.dateStatus)];
        });
        const m = location.pathname.match(/^\/is-ilanlari\/(.+?)(?:-(\d+))?\/?$/);
        const nextPath = m ? '/is-ilanlari/' + m[1] + '-' + ((Number(m[2]) || 1) + 1) : null;
        const next = !!nextPath && [...document.querySelectorAll('a[href]')].some((a) => a.getAttribute('href').split('?')[0] === nextPath);
        return 'JT_PAGE ' + JSON.stringify({ v: 1, source: 'kariyer_net', url: location.href, marker, root: !!document.querySelector(S.listRoot), next, cards });
      })();
    },
  },
  indeed: {
    label: "Indeed",
    origin: "https://tr.indeed.com",
    path: new RegExp("^/jobs\\/?$"),
    read: function () {
      return (() => {
        const S = {"card":"a[data-jk]","title":"span[id^=\"jobTitle-\"]","cardRoot":"li","company":"[data-testid=\"company-name\"]","location":"[data-testid=\"text-location\"]"};
        const MARKERS = ["cf_chl_opt","Additional Verification Required","<title>Security Check","<title>Just a moment"];
        const EMBEDDED = "window.mosaic.providerData[\"mosaic-provider-jobcards\"]=";
        const html = document.documentElement.outerHTML;
        const marker = MARKERS.find((m) => html.includes(m)) || null;
        const objectAt = (src, start) => {
          const open = src.indexOf('{', start);
          if (open < 0) return null;
          let depth = 0, inString = false, escaped = false;
          for (let i = open; i < src.length; i++) {
            const ch = src[i];
            if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
            if (ch === '"') inString = true; else if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
          }
          return null;
        };
        let results = null;
        const script = [...document.scripts].map((s) => s.textContent || '').find((t) => t.includes(EMBEDDED));
        if (script) {
          try {
            const data = JSON.parse(objectAt(script, script.indexOf(EMBEDDED) + EMBEDDED.length));
            results = data.metaData.mosaicProviderJobCardsModel.results;
          } catch (e) { results = null; }
        }
        const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '') || null;
        const cards = Array.isArray(results)
          ? results.map((r) => [r.jobkey || null, r.displayTitle || r.title || null, r.company || null, r.formattedLocation || r.jobLocationCity || null, r.jobLocationState || null, r.remoteLocation ? 1 : 0, (r.jobTypes || []).join(', ') || null, r.pubDate || null, r.formattedRelativeTime || null, r.companyOverviewLink || null])
          : [...document.querySelectorAll(S.card)].map((a) => {
              const root = a.closest(S.cardRoot);
              return [a.getAttribute('data-jk'), text(a.querySelector(S.title)) || text(a), root ? text(root.querySelector(S.company)) : null, root ? text(root.querySelector(S.location)) : null, null, 0, null, null, null, null];
            }).filter((row) => row[1]);
        return 'JT_PAGE ' + JSON.stringify({ v: 1, source: 'indeed', url: location.href, marker, root: Array.isArray(results), next: cards.length >= 10, cards });
      })();
    },
  },
};
