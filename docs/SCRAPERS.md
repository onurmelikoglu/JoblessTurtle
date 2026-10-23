# İlan sitesi taraması (Kariyer.net, Indeed)

Kariyer.net ve Indeed'in **oturum açmadan görülebilen arama sayfaları** belirli aralıklarla (varsayılan 4 saat) taranır; elle de başlatılabilir. Taranan ilanlar sunucu genelinde ortak bir kayıtta (`ScrapedJob`) tekilleştirilerek tutulur; arama profiline uyan yeni ilanlar her çalışma alanına "Kariyer.net taraması" / "Indeed taraması" kaynağıyla eklenir ve bildirim gelir.

Giriş, hesap ya da iş alarmı kullanılmaz. Site erişimi engellerse (403, CAPTCHA, bot koruması) o sitenin taraması durur, nedeni kaydedilir, yöneticiye bildirilir ve site bir süre (varsayılan 24 saat) zamanlamadan çıkar. **Engel aşılmaya çalışılmaz**: CAPTCHA çözme, tarayıcı kimliği taklidi, vekil sunucu / IP değiştirme yoktur. İstemci kendini `HTTP_USER_AGENT` ile dürüstçe tanıtır ve robots.txt kurallarına (joker, en uzun eşleşme, Allow önceliği) uyar.

## Doğrulama durumu (20 Ekim 2026)

| Site | Sayfa yapısı | Sunucudan erişim | Sonuç |
|---|---|---|---|
| Kariyer.net `/is-ilanlari/<şehir>`, `-2`, `-3`… | Gerçek sayfalardan okundu; sayfa başına 53 kart, hepsi ayrıştı | **Aralıklı.** Sayfa CDN önbelleğindeyse (`x-cache: Hit`) 200 geliyor; önbellek dışı istekler PerimeterX doğrulamasına (403) düşüyor. Aynı gün İstanbul ve İzmir birer kez açıldı, birer kez engellendi; Kocaeli engellendi | Çalışıyor, ama hangi şehrin ne zaman açılacağı öngörülemez. Engel kaydedilir, tarama durur |
| Kariyer.net anahtar kelimeli arama (`?kw=`, pozisyon adresleri) | Doğrulanamadı | Her denemede 403 (PerimeterX) | Kullanılmıyor; anahtar kelimeler şehir sayfası üzerinde **yerelde süzülür** (`keyword_mode: local_filter`) |
| Kariyer.net ilan ayrıntısı | Sayfada `JobPosting` JSON-LD yok; içerik istemci tarafında | Önbellek dışı, bot korumalı | Okunmuyor; zorunlu alanların hepsi liste kartında var |
| Indeed `/jobs?q=&l=&sort=date` | Tarayıcıda açılan gerçek sayfadan okundu (gömülü `mosaic-provider-jobcards` JSON'u + kartlar); ayrıştırıcı aynı sayfanın ham HTML'inde doğrulandı | **Engelli.** Sunucudan her istek Cloudflare "Security Check" sayfasıyla 403 | Tarayıcı ve ayrıştırıcı hazır; site izin vermediği için sunucudan ilan gelmiyor, çalışmalar `blocked` kaydedilir |
| Indeed 2. sayfa ve sonrası | robots.txt yalnızca `&start=N&` biçimine izin veriyor | Oturumsuz kullanıcı giriş sayfasına yönlendiriliyor | Varsayılan sayfa sınırı 1; yönlendirme `login_required` hatası olarak kaydedilir |
| Indeed ilan ayrıntısı (`/viewjob`) | — | robots.txt yasaklıyor | Okunmuyor; bağlantı yalnızca kullanıcının tıklaması içindir |

Bu sitelerin en eksiksiz ve kararlı kaynağı yine **iş alarmı mailleridir** ([SETUP.md › İş alarmları](SETUP.md#iş-alarmları)); tarama onu tamamlar, yerine geçmez.

Durumu yeniden ölçmek için (veritabanına yazmaz, her siteye robots.txt + tek sayfa isteği):

```bash
cd backend && npm run scrapers:check -- kariyer_net İzmir
cd backend && npm run scrapers:check -- indeed İstanbul "Flutter Developer"
```

Docker içinde: `docker compose exec api node dist/src/scraper-check.js kariyer_net İstanbul`.

## Tarayıcı eklentisi (kullanıcının açtığı sayfa)

Sunucudan erişim engelli olduğu için ilanlar kullanıcının **kendi tarayıcısında açtığı** arama sonuç sayfasından da alınabilir: `browser-extension/` klasöründeki Chrome eklentisi (Manifest V3, derleme yok; kurulum: [browser-extension/README.md](../browser-extension/README.md)).

- **Ne yapar, ne yapmaz.** Eklenti yalnızca açık sayfanın DOM'unu okur. Siteye kendi başına istek atmaz, gezinmez, tıklamaz, sayfaya yazmaz; "bot gibi görünmemek" için bekleme ya da gizlenme yoktur. Sayfada doğrulama (PerimeterX, Cloudflare) varsa aktarım yapılmaz, kullanıcıya "sayfada doğrulama var, tamamlayınca tekrar dene" denir. Gözetimsiz tarayıcı ajanı ve CAPTCHA aşma kapsam dışıdır.
- **Okuma betikleri sunucuda.** `engine/scrapers/parsers/<site>.browser.ts` sayfayı okuyan betiği (`BaseScraper.browserScript()`) ve çıktısını sunucudaki kart biçimine çeviren fonksiyonu (`fromBrowser()`) birlikte tutar; selector'lar ve bot koruması işaretleri sunucudaki ayrıştırıcıyla aynı dosyadan (`selectors/<site>.ts`) gelir. Betik `"JT_PAGE " + JSON.stringify({ v, source, url, marker, root, next, cards })` döndürür; kartlar kısa dizilerdir. Eklentideki `extractors.js` bu betiklerden **üretilir** (`cd backend && npm run extension:extractors`; MV3 içerik betiğinde eval olmadığı için metin değil kod olarak gömülür). Birim testi dosyanın güncel olduğunu denetler: betik değişip dosya yeniden üretilmezse test kırılır.
- **Akış.** Sağ alttaki "Jobless Turtle'a aktar" düğmesi → içerik betiği okur → arka plan service worker'ı `POST /api/v1/scrapers/import`'a gönderir (`X-Import-Token`) → sunucu adresin o sitenin arama sayfası olduğunu doğrular (Kariyer.net `www.kariyer.net/is-ilanlari/<ek>(-N)`, şehir ekin ilk parçasından; Indeed `tr.indeed.com/jobs`, şehir `l`, anahtar kelime `q` parametresinden) → `fromBrowser` → `listingsOf` → `ScrapedJobRepository.upsert` → çalışma alanına aktarım zamanlanmış taramayla aynı yoldan. Aktarım yalnızca anahtar sahibinin çalışma alanlarına yapılır; görülen her ilan aday olur (ortak kayıtta "yeni" olmasa da kullanıcıya yeni olabilir), çalışma alanında zaten olan ilan tekilleştirmede elenir. Sayfada küçük bir bildirim çıkar: "52 ilan aktarıldı, 3'ü profiline uyuyor".
- **Otomatik aktarım.** Uygulamadaki "Kariyer.net'te ara" / "Indeed'de ara" bağlantıları (`GET /api/v1/scrapers/extension/searches`: profilin ilk iki unvanı × şehirleri; Kariyer.net'te şehir sayfası, Indeed'de `/jobs?q=&l=&sort=date`) adresin sonuna `#jt-import` ekler. Eklenti bunu görünce o sekmede (sessionStorage) her sonuç sayfasını bir kez kendiliğinden aktarır; sitenin kendi sayfa geçişleri (Nuxt) için adres değişimi izlenir. Sayfa geçişini kullanıcı yapar.
- **Çalışma kaydı.** Her aktarım `trigger: 'extension'`, tek sayfalık bir `ScraperRun`'dır. Site kilidine takılmaz, zamanlamayı (`nextRunAt`), sitenin sağlık durumunu ve yönetici bildirimini etkilemez; geçmişte "(eklenti)" olarak görünür. Doğrulama sayfasında çalışma açılmaz (`{ status: 'verification' }`); düzeni değişmiş sayfa `failed` + `selector` hatasıyla kaydedilir.
- **Anahtar.** Kullanıcı başına bir eklenti anahtarı (`ExtensionKey`): `jt_<kimlik>.<gizli>`; yalnızca gizli kısmın SHA-256 özeti saklanır, karşılaştırma sabit zamanlıdır, düz metin üretildiği yanıtta bir kez döner. Yeni anahtar eskisini geçersiz kılar; Profilim › Tarayıcı eklentisi bölümünden üretilir ve iptal edilir. Eklenti uygulama adresine yalnızca kullanıcının seçenekler sayfasında izin verdiği köken için (isteğe bağlı host izni) istek atar.
- **Doğrulama (23 Ekim 2026).** Betikler yerleşik tarayıcıda normal kullanıcı gibi açılan sayfalarda çalıştırıldı: Kariyer.net İstanbul şehir sayfasında 53 kartın tüm alanları okundu, sonraki sayfa bulundu; hemen ardından açılan 2. sayfa PerimeterX doğrulaması verdi ve betik bunu `marker: "px-captcha"` olarak bildirdi (geçilmeye çalışılmadı). Indeed `/jobs?q=flutter&l=İstanbul` sayfasında gömülü veriden 6 ilan okundu; sayfadaki görünmez boş kart (gömülü veride yok) DOM yedeğinde unvansız olduğu için atlanır. Okunan veri boş bir test veritabanına `POST /import` ile aktarıldı: 6 ilan, 3'ü test profiline uydu.

## Mimari

```
backend/src/
├── domain/
│   ├── scraper-config.ts      ayar şeması, varsayılanlar, kısmi güncelleme, site listesi
│   ├── scraped-jobs.ts        standart ilan modeli, normalizasyon, kimlik, benzerlik, içerik özeti, durum eşikleri
│   ├── robots.ts              robots.txt ayrıştırıcı (RFC 9309)
│   └── provinces.ts           il plaka tablosu (Indeed "T34" → İstanbul)
├── engine/
│   ├── scraper.service.ts     çalışma açma/yürütme, ölçümler, aktarım, bildirim, zamanlama, sorgular
│   └── scrapers/
│       ├── base-scraper.ts    ortak soyut tarayıcı: hedefler, sayfalama, hata sınıflandırma, durdurma
│       ├── http-client.ts     robots.txt, istek aralığı, yeniden deneme + üstel bekleme, Retry-After, engel algılama
│       ├── rate-limiter.ts    site başına istek aralığı ve eşzamanlılık havuzu
│       ├── kariyer-net.scraper.ts / indeed.scraper.ts
│       ├── parsers/           siteye özel ayrıştırıcılar (HTML → ham kart)
│       ├── selectors/         siteye özel adres kalıpları, selector'lar, bot koruması işaretleri
│       ├── scraped-job.repository.ts   upsert, durum yaşam döngüsü, süzme + sayfalama
│       └── registry.ts        site → tarayıcı
├── modules/scrapers/          REST API
├── contracts/scrapers.ts      API yanıt sözleşmesi (web arayüzüyle paylaşılır)
└── scraper-check.ts           canlı yapı kontrolü (CLI)
```

Akış: zamanlayıcı (worker, dakikada bir, tek lider) ya da API → `ScraperRun` (`queued`) + `scraper.run` olayı → worker `scrape` kuyruğu → `ScraperService.execute` → tarayıcı sayfaları dolaşır → her sayfanın ilanları `ScrapedJobRepository.upsert` ile yazılır → çalışma bitince durum eşikleri uygulanır → yeni ilanlar `JobSearchService.applyListings` ile çalışma alanlarına aktarılır → engel/düzen sorunu varsa yöneticiye bildirim.

**Eşzamanlılık.** Aynı site için sırada ya da çalışan bir çalışma varken yenisi açılmaz; kontrol ve ekleme Postgres danışma kilidi (`pg_advisory_xact_lock`) altında yapıldığından API, zamanlayıcı ve birden çok worker yarışamaz. Çalışma yalnızca `queued` iken sahiplenilir; kuyruk aynı işi iki kez teslim etse de bir kez yürür. `run_timeout_minutes` içinde bitmeyen çalışma `failed` olur. Siteler birbirinden bağımsız çalışır; birinin engeli ya da hatası diğerini etkilemez.

**Hata türleri** (çalışmanın `errors` alanında ayrı tutulur):

| Tür | Anlamı | Davranış |
|---|---|---|
| `blocked` | 403/401, CAPTCHA ya da bot koruması sayfası (200 dönse bile) | Sitenin taraması durur, `block_cooldown_hours` beklenir, yönetici bildirimi |
| `rate_limited` | 429 ve `Retry-After` izin verilenden uzun ya da yok | Tarama durur, bekleme süresi uygulanır, yönetici bildirimi |
| `robots` | robots.txt yasaklıyor ya da okunamadı (5xx) | İstek atılmaz, o arama biter |
| `login_required` | Site giriş sayfasına yönlendirdi | Oturum açılmaz, o arama biter |
| `selector` | Sayfa geldi ama ilan yapısı yok / hiçbir karttan zorunlu alanlar okunamadı | Arama biter, yönetici bildirimi ("sayfa düzeni değişmiş olabilir") |
| `parse` | Gömülü veri bozuk ya da zorunlu alanı eksik kartlar atlandı | Kayıt; eksik kart uydurulmaz |
| `network` | Zaman aşımı, bağlantı hatası, 5xx | `max_retries` kez üstel beklemeyle yeniden denenir, sonra arama biter |
| `forward` | İlanlar çalışma alanlarına aktarılamadı | Tarama sonucu korunur, hata kaydedilir |

Çalışma durumu: `succeeded`, `partial` (bazı sayfalar alınamadı), `blocked`, `rate_limited`, `failed` (hiç sayfa alınamadı), `skipped` (ayarlardan kapalı). Engelli bir tarama asla başarılı gösterilmez; engele kadar alınan ilanlar kaydedilir.

## Veri modeli ve tekilleştirme

| Alan | Açıklama |
|---|---|
| `source` + `external_id` | Tekil anahtar. Platformun ilan numarası (Kariyer.net adresin sonundaki sayı, Indeed `jobkey`); yoksa sadeleştirilmiş ilan adresinin SHA-256 özeti (`u-…`) |
| `company_name`, `job_title`, `city`, `job_url`, `source` | Zorunlu; biri okunamayan kart kaydedilmez |
| `district`, `company_url`, `description`, `employment_type`, `work_mode`, `published_at`, `published_text` | Sayfada varsa; yoksa `null` (uydurulmaz). Kariyer.net kartındaki tarih "güncellendi" ise yayın tarihi `null` kalır |
| `first_seen_at` / `last_seen_at` | İlk görülme korunur; her görülmede son görülme ilerler |
| `status` | `active` → `missing_after_hours` görülmezse `missing` → `expire_after_days` görülmezse `expired`. Silinmez; yeniden görülürse `active` |
| `duplicate_of` | Yardımcı benzerlik: farklı numara ama aynı firma çekirdeği + unvan + şehirde etkin ilan varsa ana kayda bağlanır; aynı sitedeyse yeni sayılmaz |
| `content_changed_at` | İçerik özeti değişince (firma, unvan, konum, çalışma türü, açıklama…) güncellenir; göreli tarih metni ("2 gün") özete girmez |

Çalışma alanına aktarımda: unvan ve uzaktan/yurt dışı süzgeci, firma eşleme ve keşif, iş kaydında tekilleştirme (firma + unvan + bölge) ilan aramasıyla aynı hattan geçer. Profilin şehir seçimi varsa yalnızca o şehirlerdeki (ve uzaktan) ilanlar aktarılır. Adı gizli firmanın ("Gizli Firma") ilanı aktarılmaz. Görülmeye devam eden ilanların çalışma alanındaki kaydı tazelenir; görülmeyenler mevcut eskime kuralıyla kapanır.

## Ayar

`GET /api/v1/scrapers/config` okur, `POST` (ya da `PUT`) kısmi günceller; tamamı doğrulanır. Kod değişikliği gerekmez; arayüzde **Profilim › İlan siteleri taraması** bölümünden de yönetilir.

```json
{
  "enabled": true,
  "sources": {
    "kariyer_net": { "enabled": true, "interval_hours": 4, "max_pages": 5, "concurrency": 1, "request_delay_ms": 4000, "keyword_mode": "local_filter" },
    "indeed":      { "enabled": true, "interval_hours": 4, "max_pages": 1, "concurrency": 1, "request_delay_ms": 5000, "keyword_mode": "query" }
  },
  "cities": ["İstanbul", "Ankara", "İzmir", "Kocaeli"],
  "keywords": [],
  "notify_only_new": true,
  "forward_to_workspaces": true,
  "max_retries": 2,
  "retry_base_ms": 2000,
  "max_retry_after_seconds": 120,
  "block_cooldown_hours": 24,
  "missing_after_hours": 48,
  "expire_after_days": 14,
  "run_timeout_minutes": 60
}
```

- `sources.<site>.cities` / `keywords` verilirse o site için genel listeyi ezer.
- `keywords` boşsa şehrin genel ilan araması yapılır. Kariyer.net için `keyword_mode: "query"` reddedilir (doğrulanmış arama adresi yok).
- `notify_only_new: false` güncellenen ilanları da çalışma alanlarına iletir.
- **Şehir sırası önemlidir**: site bir şehirde engellerse tarama orada durur, sonraki şehirlere istek atılmaz. Varsayılan sırada büyük şehirler öndedir (önbellekte bulunma olasılıkları daha yüksek).
- Engelden sonra site `block_cooldown_hours` (varsayılan 24) bekler; engel sık görülürse fiilî tarama sıklığı günde bire iner. Daha sık deneme için bu değer düşürülebilir (en az 1).
- Sunucu düzeyinde tamamen kapatmak için `.env`: `SCRAPERS_ENABLED=false`.

## REST API

Eklentinin `import` uçları dışında hepsi oturum ister (`Authorization: Bearer …`). Tarama başlatma ve ayar yazma yalnızca sunucu yöneticisine açıktır; taramalar ve taranan ilanlar sunucu genelinde ortaktır. Tarama isteği bloklamaz: çalışma kuyruğa alınır (`202`), kimliğiyle sorgulanır.

| Uç | Açıklama |
|---|---|
| `POST /api/v1/scrapers/run` | `{ "source": "kariyer_net" \| "indeed" \| "all", "cities"?, "keywords"?, "max_pages"? }` → `{ runs: [{ id, state: "queued", already_running }] }` |
| `GET /api/v1/scrapers/status` | Site başına sağlık, son ve etkin çalışma, sıradaki zaman, etkin ve son 24 saatteki yeni ilan sayısı |
| `GET /api/v1/scrapers/history` | `?source=&state=&limit=&cursor=` çalışma geçmişi (ölçümler + hatalar) |
| `GET /api/v1/scrapers/history/{id}` | Tek çalışma |
| `GET /api/v1/scrapers/config` · `POST`/`PUT /api/v1/scrapers/config` | Ayar |
| `GET /api/v1/scrapers/jobs` | `?source=&city=&company=&title=&status=&from=&to=&only_new=&since=&include_duplicates=&limit=&cursor=` → `{ items, total, next_cursor }` |
| `GET /api/v1/scrapers/jobs/new` | `since` (varsayılan son 24 saat) sonrasında ilk kez görülen ilanlar; diğer süzgeçler aynı |
| `GET /api/v1/scrapers/jobs/{id}` | Tek ilan |
| `GET`/`POST`/`DELETE /api/v1/scrapers/extension/key` | Eklenti anahtarının durumu (`exists`, `created_at`, `last_used_at`) / yeni anahtar (`{ key, created_at }`, bir kez) / iptal (`204`) |
| `GET /api/v1/scrapers/extension/searches` | Profilden eklenti arama adresleri: `{ searches: [{ source, label, city, keyword, url }] }` |
| `POST /api/v1/scrapers/import` | Oturum yerine `X-Import-Token`. `{ source, url, payload }` → `{ status: "imported", run_id, state, listings_found, listings_new, listings_updated, forwarded, has_next_page }` · `{ status: "verification", message }` · `{ status: "failed", run_id, message }`. Anahtar yok/yanlış `401`, adres o sitenin arama sayfası değil `400` |
| `GET /api/v1/scrapers/import/check` | `X-Import-Token` ile anahtarı dener → `{ ok, display_name }` (eklentinin seçenekler sayfası) |

`city` süzgeci şehir ve ilçede arar; `from`/`to` ilk görülme tarihine uygulanır; yinelenen kayıtlar (`duplicate_of`) `include_duplicates=true` olmadıkça listelenmez. Ölçümler: `pages_visited`, `pages_failed`, `listings_found`, `listings_new`, `listings_updated`, `duplicates`, `forwarded`, `started_at`, `finished_at`, `duration_ms`, `error_summary`, `errors[]`.

Başka bir servisten süreç içinde (NestJS bağımlılığı olarak) doğrudan çağırmak:

```ts
const run = await scraperService.run({ source: 'kariyer_net', cities: ['İstanbul', 'Kocaeli'], keywords: ['Flutter Developer'], max_pages: 5 });
// run.state: succeeded | partial | blocked | rate_limited | failed ; run.listings_new, run.errors …
```

Bu yol çalışmayı bu süreçte yürütür ve bitince döner; aynı site için çalışan bir tarama varsa `already_running: true` ile hemen döner.

## Yeni site eklemek

1. `domain/scraper-config.ts`: `SCRAPER_SOURCES`, `WORKSPACE_SOURCE_KIND`, `SCRAPER_LABELS` ve `DEFAULT_SCRAPER_CONFIG.sources`'a ekle.
2. `engine/scrapers/selectors/<site>.ts`: adres kalıbı, selector'lar ve bot koruması işaretleri — **gerçek sayfadan** okunarak.
3. `engine/scrapers/parsers/<site>.parser.ts`: HTML → `RawCard[]` + `hasNextPage`; yapı yoksa `ScrapeError('selector')`.
4. `engine/scrapers/<site>.scraper.ts`: `BaseScraper`'dan türet (`searchUrl`, `parse`, `supportsKeywordQuery`, `blockMarkers`); `registry.ts`'e ekle.
5. `engine/connectors/manual.ts`: çalışma alanı kaynağını (`scrape_<site>`) kaydet.
6. `test/unit/fixtures/scrapers/` altına yapısı gerçek, içeriği kurgusal sayfalar; ayrıştırıcı ve engel algılama testleri.
7. Eklenti: `parsers/<site>.browser.ts` (tarayıcı betiği + `fromBrowser`), sınıfta `browserScript`, `fromBrowser`, `searchOfPage`; `extension-extractors.ts`'teki `SEARCH_PAGES`'e arama sayfası yolu; `browser-extension/manifest.json`'da `content_scripts.matches`; ardından `npm run extension:extractors`.

## Testler

- Birim (`test/unit/scrapers.spec.ts`): ayrıştırıcılar kayıtlı sayfalarla, engel ve düzen değişikliği algılama, robots.txt, yeniden deneme/üstel bekleme/Retry-After/403/giriş duvarı, hız sınırlayıcı ve havuz, normalizasyon, kimlik, benzerlik, ayar birleştirme.
- Birim (`test/unit/scraper-extension.spec.ts`): `fromBrowser` (alanlar, doğrulama/selector/parse ayrımı, boyut sınırları), eklentinin gönderdiği adresin doğrulanması, `extractors.js`'in güncelliği ve betiklerin istek/gezinme yapmaması, profilden arama hedefleri.
- Uçtan uca (`test/e2e/scraper-import.e2e-spec.ts`): anahtar üretme/yenileme/iptal ve yalnız özetin saklanması, anahtar yok/yanlış `401`, yanlış host/yol `400`, doğrulama yanıtı (çalışma açılmaz), düzen değişikliği, tekilleştirme, yalnız anahtar sahibinin profiline aktarım ve bildirim, eklenti çalışmalarının kilit/zamanlama/sağlık durumunu etkilememesi, arama adresleri. Ağ katmanı istek atılırsa testi düşürür.
- Uçtan uca (`test/e2e/scrapers.e2e-spec.ts`, gerçek PostgreSQL + Redis, sahte ağ katmanı — gerçek siteye istek atılmaz): sayfalama ve ölçümler, yeniden taramada kayıt açılmaması, içerik güncelleme, yeniden yayın, missing/expired/yeniden etkinleşme, çalışma alanına aktarım ve bildirim, engel/hız sınırı/düzen değişikliği/ağ hatası ayrımı, bir sitenin engelinin diğerini etkilememesi, eşzamanlı ikinci çalışmanın açılmaması, çift teslimde tek yürütme, zamanlayıcı ve zaman aşımı, API süzgeçleri ve sayfalama, yetki ve ayar doğrulaması.
