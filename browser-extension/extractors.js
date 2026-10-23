// Bu dosya üretilir; elle düzenlenmez. Kaynak: backend/src/engine/scrapers/parsers/*.browser.ts
// Yeniden üretmek için backend klasöründe: npm run extension:extractors
globalThis.JT_EXTRACTORS = {
  kariyer_net: {
    label: "Kariyer.net",
    origin: "https://www.kariyer.net",
    path: new RegExp("^\\/is-ilanlari(?:\\/([a-z0-9+-]+?)(?:-\\d+)?)?\\/?$"),
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
        const cp = Number(new URLSearchParams(location.search).get('cp')) || 1;
        const hrefs = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
        const nextQueryPage = hrefs.some((href) => {
          try {
            const u = new URL(href, location.origin);
            return u.pathname.startsWith('/is-ilanlari') && u.searchParams.has('kw') && Number(u.searchParams.get('cp')) === cp + 1;
          } catch (e) {
            return false;
          }
        });
        const next = nextQueryPage || (!location.search.includes('kw=') && !!nextPath && hrefs.some((href) => href.split('?')[0] === nextPath));
        return 'JT_PAGE ' + JSON.stringify({ v: 1, source: 'kariyer_net', url: location.href, marker, root: !!document.querySelector(S.listRoot), next, cards });
      })();
    },
  },
  indeed: {
    label: "Indeed",
    origin: "https://tr.indeed.com",
    path: new RegExp("^\\/jobs\\/?$"),
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
  eleman_net: {
    label: "Eleman.net",
    origin: "https://www.eleman.net",
    path: new RegExp("^\\/is-ilanlari(?:\\/([a-z0-9-]+))?\\/?$"),
    read: function () {
      return (() => {
        const S = {"card":".ilan_listeleme_bol","link":"a[href*=\"/is-ilani/\"]","title":"h3.c-showcase-box__title","titleNoise":".ilantik-grubu","subtitle":".c-showcase-box__subtitle","text":".c-showcase-box__text"};
        const MARKERS = ["cf_chl_opt","<title>Just a moment","Attention Required! | Cloudflare","px-captcha","Access to this page has been denied"];
        const PAGE = "sy";
        const html = document.documentElement.outerHTML;
        const marker = MARKERS.find((m) => html.includes(m)) || null;
        const clean = (value) => (value || '').replace(/\s+/g, ' ').trim() || null;
        const lines = (el) => {
          if (!el) return [null, null];
          const holder = document.createElement('div');
          return el.innerHTML.split(/<br\s*\/?>/i).map((part) => {
            holder.innerHTML = part;
            return clean(holder.textContent);
          });
        };
        const cards = [...document.querySelectorAll(S.card)].map((el) => {
          const link = el.querySelector(S.link);
          const title = el.querySelector(S.title);
          let titleText = null;
          if (title) {
            const copy = title.cloneNode(true);
            copy.querySelectorAll(S.titleNoise).forEach((n) => n.remove());
            titleText = clean(copy.textContent);
          }
          const [company, place] = lines(el.querySelector(S.subtitle));
          const description = [...el.querySelectorAll(S.text)].filter((t) => !t.querySelector('i')).map((t) => clean(t.textContent)).find(Boolean) || null;
          return [link ? link.getAttribute('href') : null, titleText, company || null, place || null, description];
        });
        const current = Number(new URLSearchParams(location.search).get(PAGE)) || 1;
        const next = [...document.querySelectorAll('a[href]')].some((a) => {
          try {
            return Number(new URL(a.getAttribute('href'), location.origin).searchParams.get(PAGE)) === current + 1;
          } catch (e) {
            return false;
          }
        });
        return 'JT_PAGE ' + JSON.stringify({ v: 1, source: 'eleman_net', url: location.href, marker, root: !!document.querySelector('form[action$="/is-ilanlari"]'), next, cards });
      })();
    },
  },
  isinolsun: {
    label: "İşin Olsun",
    origin: "https://isinolsun.com",
    path: new RegExp("^\\/is-ilanlari(?:\\/([a-z0-9-]+))?\\/?$"),
    read: function () {
      return (() => {
        const S = {"link":"a[href*=\"/is-ilani/\"]","title":"h3","company":"p[title]","location":"div[title]","tag":"span"};
        const MARKERS = ["px-captcha","Access to this page has been denied","<title>Just a moment","cf_chl_opt"];
        const PAGE = "pn";
        const html = document.documentElement.outerHTML;
        const marker = MARKERS.find((m) => html.includes(m)) || null;
        const clean = (value) => (value || '').replace(/\s+/g, ' ').trim() || null;
        const cards = [...document.querySelectorAll(S.link)].filter((a) => a.querySelector(S.title)).map((a) => {
          const company = a.querySelector(S.company);
          const place = a.querySelector(S.location);
          const tag = [...a.querySelectorAll(S.tag)].map((s) => clean(s.textContent)).find((t) => t && /zaman|part|dönem|sezon|stajyer/i.test(t)) || null;
          return [a.getAttribute('href'), clean(a.querySelector(S.title).textContent), company ? clean(company.getAttribute('title') || company.textContent) : null, place ? clean(place.getAttribute('title') || place.textContent) : null, tag];
        });
        const current = Number(new URLSearchParams(location.search).get(PAGE)) || 1;
        const nextLink = document.querySelector('link[rel="next"]');
        const next = (!!nextLink && Number(new URL(nextLink.href).searchParams.get(PAGE)) === current + 1) || [...document.querySelectorAll('a[href]')].some((a) => {
          try {
            return Number(new URL(a.getAttribute('href'), location.origin).searchParams.get(PAGE)) === current + 1;
          } catch (e) {
            return false;
          }
        });
        return 'JT_PAGE ' + JSON.stringify({ v: 1, source: 'isinolsun', url: location.href, marker, root: !!document.querySelector('form[action$="/is-ilanlari"]'), next, cards });
      })();
    },
  },
  secretcv: {
    label: "Secretcv",
    origin: "https://www.secretcv.com",
    path: new RegExp("^\\/is-ilanlari(?:\\/([a-z0-9-]+))?\\/?$"),
    read: function () {
      return (() => {
        const S = {"card":".cv-job-box.job-list","title":"a.title","company":".company","location":".city > span","date":".city small"};
        const MARKERS = ["cf_chl_opt","<title>Just a moment","Attention Required! | Cloudflare","px-captcha","Access to this page has been denied"];
        const PAGE = "sf";
        const html = document.documentElement.outerHTML;
        const marker = MARKERS.find((m) => html.includes(m)) || null;
        const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '') || null;
        const cards = [...document.querySelectorAll(S.card)].map((el) => {
          const link = el.querySelector(S.title);
          return [link ? link.getAttribute('href') : null, text(link), text(el.querySelector(S.company)), text(el.querySelector(S.location)), text(el.querySelector(S.date))];
        });
        const current = Number(new URLSearchParams(location.search).get(PAGE)) || 1;
        const next = [...document.querySelectorAll('a[href]')].some((a) => {
          try {
            return Number(new URL(a.getAttribute('href'), location.origin).searchParams.get(PAGE)) === current + 1;
          } catch (e) {
            return false;
          }
        });
        const root = /^\/is-ilanlari\/[a-z0-9-]+-is-ilanlari\/?$/.test(location.pathname) && !!document.querySelector('main');
        return 'JT_PAGE ' + JSON.stringify({ v: 1, source: 'secretcv', url: location.href, marker, root, next, cards });
      })();
    },
  },
  yenibiris: {
    label: "Yenibiriş",
    origin: "https://www.yenibiris.com",
    path: new RegExp("^\\/is-ilanlari(?:\\/([a-z0-9-]+))?\\/?$"),
    read: function () {
      return (() => {
        const S = {"card":".listViewRows","title":"a.gtmTitle","company":".gtmCompanyName","location":".gtmLocation","date":".gtmDate > div[title]","tag":".listJobTag"};
        const MARKERS = ["cf_chl_opt","<title>Just a moment","Attention Required! | Cloudflare","<title>Attention Required"];
        const PAGE = "sayfa";
        const html = document.documentElement.outerHTML;
        const marker = MARKERS.find((m) => html.includes(m)) || null;
        const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '') || null;
        const cards = [...document.querySelectorAll(S.card)].filter((el) => el.querySelector(S.title)).map((el) => {
          const link = el.querySelector(S.title);
          const company = el.querySelector(S.company);
          const tags = [...el.querySelectorAll(S.tag)].map(text).filter(Boolean).join('|') || null;
          return [link.getAttribute('href'), text(link), company ? (company.getAttribute('title') || '').trim() || text(company) : null, text(el.querySelector(S.location)), text(el.querySelector(S.date)), tags];
        });
        const current = Number(new URLSearchParams(location.search).get(PAGE)) || 1;
        const next = [...document.querySelectorAll('a[href]')].some((a) => {
          try {
            return Number(new URL(a.getAttribute('href'), location.origin).searchParams.get(PAGE)) === current + 1;
          } catch (e) {
            return false;
          }
        });
        return 'JT_PAGE ' + JSON.stringify({ v: 1, source: 'yenibiris', url: location.href, marker, root: !!document.querySelector('form[action="/is-ilanlari"]'), next, cards });
      })();
    },
  },
};
