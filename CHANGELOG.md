# Değişiklik günlüğü

## Yayımlanmamış (dev)

### Tek komutla kurulum ve hazır imajlar

- **`install.sh`.** `curl -fsSL https://raw.githubusercontent.com/onurmelikoglu/JoblessTurtle/main/install.sh | bash` ya da klasörde `./install.sh`. Docker'ı kontrol eder, `.env`'i gizli anahtarları rastgele üreterek oluşturur (var olan `.env`'e dokunmaz), boş port seçer, hazır imajları indirir (indirilemezse yerelde derler), başlatır ve tarayıcıda açar. `update`, `status`, `stop` komutları; `JT_PORT`, `JT_DIR`, `JT_BUILD`, `JT_NO_OPEN`, `JT_YES` ayarları.
- **Hazır imajlar.** `.github/workflows/release-images.yml` herkese açık depoda `main`'e her gönderimde `ghcr.io/onurmelikoglu/jobless-turtle-backend` (Claude/Codex CLI dahil) ve `-web` imajlarını amd64 + arm64 için yayınlar.
- **Compose.** İmaj adları `BACKEND_IMAGE` / `WEB_IMAGE` ile seçilir; tanımsızsa eski yerel etiketler kullanılır (mevcut kurulumlar etkilenmez).

### Terminalsiz kurulum: butonla hesap bağlama, API anahtarı, eklenti indirme ve Kurulum ekranı

- **Kurulum ekranı (`/setup`).** İlk girişte sihirbazdan sonra açılır; Profilim'in başındaki **Kurulum** özetinden de ulaşılır. Adımlar ve durumları (Tamam / Eksik / İsteğe bağlı): profil ve CV, yapay zekâ bağlantısı, gönderim maili, tarayıcı eklentisi; her adımın işlemi yerinde. Ana sayfadaki mail uyarısının yerini, eksik zorunlu adımları sayan tek bir "Kurulumu tamamla" uyarısı aldı.
- **Claude ve ChatGPT hesabını butonla bağlama (yönetici).** **Claude'u bağla**: giriş sayfası açılır, sayfanın verdiği kod uygulamaya yapıştırılır. **ChatGPT'yi bağla**: tek kullanımlık cihaz kodu gösterilir (yalnızca kendi başlattığın girişte girilmesi uyarısıyla), onay verilince ekran kendiliğinden güncellenir. 15 dakika zaman aşımı, aynı anda tek giriş, Vazgeç ve **Bağlantıyı kes**. Komutlar API konteynerinde çalışır; giriş bilgileri worker ile ortak `ai-cli-home` volume'üne yazılır (compose'da api servisine bağlandı). Kod ve token veritabanına ya da loglara yazılmaz; hata metninde adresler ve belirteç benzeri dizgiler gizlenir. Bağlantı değişince worker sağlayıcı listesini en geç 30 sn'de tazeler (`ai:providers-changed`).
- **Claude bağlantı durumu.** Claude CLI artık yalnızca kurulu olduğu için değil, `claude auth status` girişli dediğinde kullanılabilir sayılır.
- **API anahtarı.** Anthropic / OpenAI anahtarı arayüzden girilir, `APP_ENCRYPTION_KEY` ile şifreli saklanır (`ai:api-keys`), yalnızca son 4 karakteri gösterilir. Girilen anahtar, CLI'nin kullanılabildiği çalışma alanlarında varsayılan sıraya aboneliklerden sonra eklenir. `.env`'deki `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` yedek kalır ve eskisi gibi kendiliğinden sıraya girmez.
- **Kopyala-yapıştır seçimi.** Hesap bağlamadan "Kopyala-yapıştır ile devam et" yapay zekâ adımını tamamlar (çalışma alanı ayarı, geri alınabilir).
- **Tarayıcı eklentisi 1.4.0.** Web imajı eklentiyi `/downloads/jobless-turtle-extension.zip` olarak sunar (**Eklentiyi indir**). **Eşleştirme kodunu kopyala** tek dizgide adres ve anahtarı verir (`jt1.` + base64url JSON); eklenti ayarlarında tek alana yapıştırılır (adres ve anahtar alanları da çalışır), kaydederken adres izni istenir ve uygulama köprüsü kaydedilir. Uygulama eşleşmiş eklentiyi algılar (`data-jt-extension`) ve eski sürümde güncelleme önerir. İlk kurulumda ayarlar kendiliğinden açılır. Chrome Web Mağazası metni ve paketleme notu: `browser-extension/CHROME-WEB-STORE.md`.
- **API.** Yeni: `GET /api/v1/ai/setup`, `POST /api/v1/ai/setup/manual`; yönetici: `GET /api/v1/ai/connect`, `POST /api/v1/ai/connect/{cli_claude|cli_codex}/login`, `POST …/code`, `DELETE …/login`, `POST …/logout`, `GET /api/v1/ai/api-keys`, `PUT|DELETE /api/v1/ai/api-keys/{anthropic_api|openai_api}`.
- **Geçiş.** Veritabanı değişikliği yok. API, worker ve web birlikte güncellenir; api servisine `ai-cli-home` volume'ü bağlandığı için api de yeniden oluşturulur. Eklentiyi `chrome://extensions` sayfasında yenile.

### Yapay zekâ: görev türüne göre sağlayıcı ve model seçimi (bütün kullanıcılar)

- **Sağlayıcı seçimi.** Profilim › AI kullanımı ve modeller'de her görev türü için "Kullanılacak: Otomatik / Claude / ChatGPT" seçilir. Seçilen sağlayıcı önce denenir; limit ya da hata verirse diğeri devralır.
- **Model seçimi.** Modeller elle yazılmaz, listeden seçilir: Claude için Haiku / Sonnet / Opus; ChatGPT için hesabın kullanabildiği modeller (worker, Codex CLI'nin model önbelleğinden okur ve on dakikada bir günceller). Listede olmayan bir model kaydedilemez.
- **Herkese uygulanır.** Ayar sunucu genelidir (`server:ai-routing`), yalnızca yönetici değiştirir (`PATCH /api/v1/ai/routing`) ve davetlilerin çalışma alanlarında da geçerlidir (önceden modeller yalnızca yöneticinin çalışma alanına uygulanıyordu). İlk açılışta yöneticinin mevcut model ayarı kullanılır.
- **Geçiş.** Veritabanı değişikliği yok.

### Bildirimler: arama, tarih-saat filtresi, geçmişi temizleme

- **Arama.** Bildirimler sayfasının üstünde arama kutusu: yazdıkça (300 ms gecikmeyle) başlıkta ve içerikte arar; büyük/küçük harf ve Türkçe harf farkı gözetilmez ("basvuru" → "Başvuru", "MAVİ" → "Mavi"). Birden çok sözcük yazılırsa hepsi geçmelidir.
- **Tarih-saat aralığı.** Başlangıç / bitiş alanları ve hazır aralıklar (Son 1 saat, Bugün, Son 24 saat, Son 7 gün), "Yalnızca okunmamışlar", sonuç sayısı ve "Filtreyi temizle". Liste 30'ar kayıt yüklenir, "Daha fazla göster" ile devam eder.
- **Geçmişi temizle.** Tarayıcı geçmişi gibi: Son 1 saat, Son 24 saat, Son 1 hafta, Tümü. Onay penceresi silinecek kapsamı söyler; silmeden sonra toast, liste ve üst menüdeki okunmamış sayacı yenilenir. Satırdaki × ile tek bildirim de silinir. Yalnızca kullanıcının bu çalışma alanındaki uygulama içi bildirimleri silinir; Telegram teslim kayıtlarına dokunulmaz.
- **API.** `GET /api/v1/notifications` artık `q`, `from`, `to` (ISO 8601; 30 gün sınırı korunur), `unread`, `limit` (en çok 100, varsayılan 50), `cursor` alır ve `{ items, total, unread, next_cursor }` döndürür (önceden düz dizi, en çok 100 kayıt). Yeni: `DELETE /api/v1/notifications?range=1h|24h|7d|all` ve `DELETE /api/v1/notifications/{id}` → `{ deleted }`.
- **Geçiş.** Veritabanı değişikliği yok. Yanıt biçimi değiştiği için API ve web birlikte güncellenir.

### Eklenti: aramayı başlatan hesaba aktarım, en az sayıda arama

- **Hangi hesaba?** Eklenti aktarımı artık aramayı uygulamada başlatan hesabın çalışma alanına gider (önceden her zaman anahtar sahibine). Uygulamanın verdiği arama adresleri `#jt-import=<etiket>` ekiyle gelir; etiket çalışma alanını şifreli taşır, sunucu doğrular (bozuk etiket `400`). Etiketsiz aktarım anahtar sahibine gider. Çalışma kaydına hedef çalışma alanı yazılır (`ScraperRun.targetWorkspaceId`).
- **En az arama.** "… ara" düğmeleri pozisyon × şehir seçtirmez: Kariyer.net'te bütün şehirler tek aramada (`?ct=34,82,41&kw=…`), Indeed'de pozisyonlar VEYA ile (`"a" or "b"`, şehir başına), Eleman.net ve Secretcv'de pozisyon başına ülke geneli arama; İşin Olsun ve Yenibiriş birleşik aramayı desteklemediği için pozisyon × şehir. Tek arama doğrudan açılır, menü yalnızca birden çok arama gerekiyorsa çıkar. "Hepsini aç" en çok 20 sekme.
- **Bildirim.** "N ilan aktarıldı, M'i profile uyuyor".
- **Eklenti 1.3.0.** `chrome://extensions` sayfasında yenile.
- **Geçiş.** `ScraperRun` tablosuna `targetWorkspaceId` kolonu (`20261023150000_scraper_run_target`, yalnız ekleme).

### Yeni ilan siteleri: Eleman.net, İşin Olsun, Secretcv, Yenibiriş

- **Sunucu taraması.** Eleman.net ve İşin Olsun üyeliksiz arama sayfalarıyla 4 saatte bir taranır (robots.txt izin veriyor, sunucudan erişim açık; anahtar kelime sitenin aramasında). Secretcv'de robots.txt arama ve sayfalamayı yasakladığı için yalnızca şehir sayfasının ilk sayfası okunur, anahtar kelimeler yerelde süzülür. Yenibiriş sunucudan gelen her isteği Cloudflare ile geri çevirdiği için sunucu taraması yoktur ve ayardan açılamaz.
- **Eklenti 1.2.0.** Dört site de eklentiyle aktarılır (arama, sonraki sayfalar ve sitenin kendi sayfa geçişleri dahil); Firmalar'da her site için "… ara" düğmesi, "Hepsini aç" siteleri sırayla döner. Sayfa değişimi artık tüm kartlara bakılarak anlaşılır (sabit sponsorlu kartlı sitelerde otomatik aktarım takılmaz). `chrome://extensions` sayfasında eklentiyi bir kez yenilemek gerekir.
- **Konum.** "İstanbul Anadolu Yakası - Kadıköy", "İstanbul Avrupa" gibi yaka adları il adına iner; tekrar eden konum parçaları birleşir. "Son 1 Hafta" gibi aralıklardan yayın tarihi üretilmez.
- **Yönetici bölümü.** Yeni siteler İlan siteleri taraması bölümünde görünür; yalnızca eklentili site "Yalnızca eklenti" olarak işaretlenir. Youthall eklenmedi (staj ve yeni mezun platformu).
- **Geçiş.** Veritabanı değişikliği yok; kayıtlı tarama ayarı yeni sitelerin varsayılanlarıyla tamamlanır. Ayrıntı: [docs/SCRAPERS.md](docs/SCRAPERS.md).

### Eklenti: bütün pozisyonlar ve "Hepsini aç"

- **Bütün pozisyonlar.** Eklenti aramaları profildeki aranan pozisyonların hepsini kapsar (önceden ilk ikisi; şimdi en çok 8).
- **Hepsini aç.** Firmalar'da "Hepsini aç (N sekme)" düğmesi bütün pozisyon × şehir aramalarını (iki site, en çok 12) ayrı sekmelerde açar; her sekmedeki sonuçlar kendiliğinden aktarılır. Tarayıcının açılır pencere engelleyicisine takılmamak için sekmeleri eklenti açar; eklenti yalnızca kayıtlı uygulama adresinden gelen ve Kariyer.net / Indeed arama sonuç sayfası olan adresleri açar. Eklenti yoksa yalnızca ilk arama açılır.
- **Eklentiyi yenile.** Eklenti 1.1.0: yeni `scripting` izni; `chrome://extensions` sayfasında yenile düğmesine bir kez basmak gerekir.

### Eklenti: Kariyer.net'te unvanla arama, tekrar aktarım koruması

- **Neden.** İlk kullanımda "Kariyer.net'te ara" genel şehir sayfasını açıyordu; sayfadaki ilanların hiçbiri profildeki unvanlara uymadığı için listeye ilan düşmedi. Aynı sayfa birkaç saniye içinde üç kez aktarıldı.
- **Unvanla arama.** "Kariyer.net'te ara" artık profilin unvanı × şehir için anahtar kelimeli aramayı açar (`/is-ilanlari/<şehir>?kw=<unvan>`). Bu adres sunucudan doğrulamaya takılıyor, kullanıcının tarayıcısında açılıyor. Okuma betiği bu aramanın sonraki sayfalarını (`&cp=N`) tanır.
- **Tekrar koruması.** Aynı kullanıcının aynı sayfayı aynı kartlarla 2 dakika içinde yeniden göndermesi yeni çalışma açmaz, önceki sonuç döner.
- **Eklentiyi yenile.** `chrome://extensions` sayfasında eklentinin yenile düğmesine bir kez basmak gerekir (okuma dosyası değişti).

### Tarayıcı eklentisi: açtığın Kariyer.net / Indeed sayfasını aktar

- **Neden.** İki site de sunucudan gelen istekleri bot korumasıyla engelliyor (PerimeterX, Cloudflare); iş alarmı kurmadan ilanları hızlıca almak için kullanıcının kendi tarayıcısında baktığı sayfa okunur.
- **Eklenti.** `browser-extension/` (Chrome, Manifest V3, derleme yok; Geliştirici modu → Paketlenmemiş öğe yükle). Kariyer.net ve Indeed arama sonuç sayfalarında sağ altta "Jobless Turtle'a aktar" düğmesi; sayfada "52 ilan aktarıldı, 3'ü profiline uyuyor" gibi bir bildirim. Yalnızca açık sayfayı okur: siteye istek atmaz, gezinmez, tıklamaz. Doğrulama sayfasında aktarım yapılmaz, kullanıcı doğrulamayı tamamlayıp tekrar dener. Seçenekler: uygulama adresi + anahtar; kaydedince yalnızca o adres için erişim izni istenir.
- **Uygulamada.** Firmalar sekmesinde "Kariyer.net'te ara" / "Indeed'de ara" (profilin ilk iki unvanı × şehirleri, yeni sekmede); bu sekmede her sonuç sayfası kendiliğinden aktarılır. Profilim › Tarayıcı eklentisi: kurulum adımları, anahtar üret/yenile/iptal (anahtar bir kez gösterilir).
- **Sunucu.** `POST /api/v1/scrapers/import` (`X-Import-Token`, sabit zamanlı karşılaştırma, yalnız özet saklanır); adres o sitenin arama sayfası olmalı. Okuma betikleri sunucudaki selector'larla aynı dosyadan üretilir (`npm run extension:extractors`), kayıt/tekilleştirme/aktarım zamanlanmış taramayla aynı yoldan geçer; aktarım yalnızca anahtar sahibinin çalışma alanına yapılır. Her aktarım `trigger: extension` tek sayfalık çalışmadır; site kilidini, zamanlamayı ve sitenin sağlık durumunu etkilemez. Ayrıntı: [docs/SCRAPERS.md › Tarayıcı eklentisi](docs/SCRAPERS.md#tarayıcı-eklentisi-kullanıcının-açtığı-sayfa).
- **Geçiş.** `ExtensionKey` tablosu eklendi (`20261023100000_extension_keys`, yalnız ekleme). API, worker ve web birlikte güncellenir (worker'daki zamanlayıcı eklenti çalışmalarını yok sayar).

### Başvurulan firmalar Firmalar'da görünmez; bildirimler 30 gün

- **Neden.** Aynı firma farklı ad ya da alan adıyla ikinci kez kayda girebiliyordu ("… (İstanbul)" / "… (Türkiye / İstanbul)", firma.com / firma.com.tr). Firmalar listesi başvuruyu yalnızca kayıt kimliğiyle eşlediği için başvurulan firmanın ikinci kaydı listede kalıyordu; otomatik taslak ve otomatik başvuru da bu kaydı yeni firma sayıyordu.
- **Firma kimliği.** Ad çekirdeği (parantez içindeki diğer ad dahil; şehir, ülke, hukuki ve genel ekler atılır) ya da alan adı kökü (ülke uzantısından bağımsız) aynı olan kayıtlar aynı firma sayılır. Ad bütün olarak karşılaştırılır: "Unda Studio" ile "Unda Sigorta" ayrı kalır; ortak barındırma alanları (github.io, wixsite…) eşleşme sayılmaz.
- **Başvurularım'daki firma.** İptal edilmemiş her başvuru (gönderilemeyip listeden kaldırılanlar hariç) firmayı ve aynı firmanın diğer kayıtlarını Firmalar listesinden, fırsat listesinden, otomatik taslaktan ve otomatik başvurudan çıkarır.
- **Yeni ilan yalnızca bildirim.** Başvurulan firma arama kriterlerine uyan güncel bir ilan yayımlarsa (yayın tarihi son 30 gün ya da bilinmiyor) "Başvurduğun firmada yeni ilan" bildirimi gelir; bildirim başvurunun ayrıntısını açar. Toplu "N yeni ilan" bildirimleri bu ilanları saymaz.
- **Bildirimler 30 gün.** Listelerde son 30 günün bildirimleri gösterilir; daha eskiler worker tarafından her gün silinir (önceden 90 gün).
- **Geçiş.** Veritabanı değişikliği yok.

### İlan sitesi taraması: Kariyer.net ve Indeed

- **Ne yapar.** Kariyer.net ve Indeed'in oturum açmadan görülebilen arama sayfaları şehir (ve isteğe bağlı anahtar kelime) bazında 4 saatte bir taranır; **Profilim › İlan siteleri taraması** bölümünden elle de başlatılır. İlanlar sunucu genelinde ortak bir kayıtta tekilleştirilerek tutulur (platform ilan numarası, yoksa adres özeti; firma + unvan benzerliğiyle yeniden yayın tespiti; ilk/son görülme; içerik değişince güncelleme; görülmeyen ilan silinmez, `missing` → `expired`). Profile uyan yeni ilanlar çalışma alanlarına "Kariyer.net taraması" / "Indeed taraması" kaynağıyla eklenir ve bildirim gelir.
- **Erişim kuralları.** robots.txt'e uyulur (joker ve Allow önceliği dahil), istemci kendini tanıtır, istekler site başına aralıklandırılır, geçici hatalarda sınırlı üstel bekleme, 429'da `Retry-After`. 403/CAPTCHA/bot koruması görülünce o sitenin taraması durur, neden kaydedilir, yöneticiye bir kez bildirilir ve site 24 saat beklenir; engel aşılmaz. Bir sitenin sorunu diğerini etkilemez. Hata türleri ayrı tutulur: erişim engeli, istek sınırı, robots, giriş duvarı, sayfa düzeni (selector), ayrıştırma, ağ.
- **Doğrulanan durum (20 Ekim 2026).** Kariyer.net şehir sayfaları yalnızca CDN önbelleğindeyken açılıyor (İstanbul ve İzmir bir kez açıldı, bir kez engellendi; Kocaeli ve anahtar kelimeli arama engelli) — anahtar kelimeler bu yüzden yerelde süzülür. Indeed sunucudan her istekte Cloudflare doğrulamasıyla engelli; tarayıcı ve ayrıştırıcı gerçek sayfa yapısına göre hazır ama ilan gelmiyor. Ayrıntı: [docs/SCRAPERS.md](docs/SCRAPERS.md).
- **API.** `POST /api/v1/scrapers/run` (kuyruğa alır, bloklamaz), `GET /status`, `GET /history[/{id}]`, `GET|POST|PUT /config`, `GET /jobs`, `GET /jobs/new`, `GET /jobs/{id}` (süzgeç + imleç sayfalaması). Başlatma ve ayar yalnızca yöneticiye açık. Süreç içi kullanım: `ScraperService.run({ source, cities, keywords, max_pages })`. Canlı yapı kontrolü: `npm run scrapers:check`.
- **Geçiş.** `ScrapedJob` ve `ScraperRun` tabloları eklendi (`20261020120000_job_board_scrapers`, yalnız ekleme). Yeni ortam değişkeni `SCRAPERS_ENABLED` (varsayılan `true`). Worker'a `scrape` kuyruğu eklendi; ilk tarama deploy'dan sonraki ilk zamanlayıcı turunda başlar.

### Adres araması baştan: Sonnet toplar, Opus doğrular

- **Neden.** Eski arama ChatGPT → Sonnet → Opus sırasıyla aynı tek seferlik istemi üç kez çalıştırıyordu; istem kişisel adresleri yasaklıyor, en fazla 12 adres istiyordu ve modelin verdiği kaynak sayfası hiç açılıp kontrol edilmiyordu. Claude yedeği Haiku ile çalıştığında aramalar sık sık boş dönüyordu.
- **Yeni hat.** (1) Firma sitesi yapay zekâsız taranır. (2) **Sonnet** web'de geniş arama yapar: kariyer/iletişim/hakkımızda/KVKK sayfaları, ilan metinleri, forumlar, GitHub, konferans ve basın sayfaları; İK ve kariyer adreslerinin yanında işe alım ekibinin, yönetimin ve şirket adresini herkese açık paylaşmış çalışanların iş adreslerini de toplar (en fazla 25). (3) Her adayın kaynak sayfası düz HTTP ile okunur ve adresin gerçekten orada geçip geçmediğine bakılır ("ad [at] firma.com" gibi gizlemeler dahil); CAPTCHA ya da bot korumalı sayfa aşılmaz, "okunamadı" sayılır. (4) Derin aramada **Opus** kesin olmayan adayları denetler (tut/ele, rol, 0–100 güven, gerekçe); okunabilir sayfada görülen ve firma alan adındaki rol adresleri (ik@, kariyer@, info@) Opus'a gitmez. Claude kullanılamazsa toplama ChatGPT ile yapılır.
- **Kurallar kodda.** Kalıptan tahmin edilen adres "Tahmini" türünde ve en fazla %30 güvenle tutulur, asla doğrulanmış sayılmaz; kaynağında bulunamayan adres denetlenmediyse atılır, denetçi tutarsa %35'i geçmez; okunamayan kaynak %60, firma alan adı dışı %40, denetlenmemiş kişisel adres %40 tavanındadır. Destek, satış, KVKK, KEP adresleri ve kişisel posta servislerindeki (gmail vb.) çalışan adresleri alınmaz. Ölü listesindeki, geri dönmüş ve kullanıcının istemediği adresler hiç eklenmez. Derin aramada daha önce kaydedilmiş ama amacı belirsiz kalmış adresler de yeniden değerlendirilir.
- **Kullanım.** Yönetim, çalışan ve tahmini adresler alıcı listesinde rol adreslerinin arkasında, kesik çerçeveli ve adı/unvanı/güveniyle görünür; **yalnızca elle seçilebilir**, otomatik gönderim ve otopilot yalnız rol adreslerine (ilan, İK, işe alım çalışanı, genel) gider. Yalnız kişisel adres bulunan firmanın kartında bu durum yazılır. Kişisel adresler ortak kataloğa (diğer çalışma alanlarına) aktarılmaz.
- **Kota.** Firma başına bir Sonnet çağrısı; derin aramada kesin olmayan aday varsa bir Opus çağrısı daha. Arka plan aramaları Opus'u çağırmaz.
- **Geçiş.** `ContactPoint` tablosuna `roleType`, `score`, `evidence` kolonları eklendi (`20261015120000_contact_research`); eski kayıtlar etkilenmez.

### Bildirimler ilgili kayda götürür

- **Yeni ilan bildirimi** Firmalar listesini yalnızca o ilanlarla açar ("Bildirimdeki 2 ilan gösteriliyor"); listede kalmayanlar (başvurulmuş, gizlenmiş, kapanmış) ayrıca belirtilir, "Tüm firmaları göster" odaktan çıkar. Yeni fırsat, "Başvuruya hazır", "İnceleme bekleyen taslak" ve "Gönderilemedi" bildirimleri de ilgili ilanı bu şekilde gösterir.
- **Gönderim ve yanıt bildirimleri** Başvurularım sekmesinde o başvurunun ayrıntısını, **mail dönüşü bildirimleri** Mail dönüşleri sekmesinde o maili açar. Otopilot bildirimi kararına göre onay listesine, yeniden gönderilen başvuruya ya da dönen maile gider.
- **Bekleyen yapay zekâ görevi** bildirimi görev penceresini açar; görev çoktan tamamlandıysa bunu söyler.
- Ayrıntı taşımayan eski bildirimler türlerine uyan sekmeye gider (eski yeni ilan bildirimleri Firmalar'ı en yeni sırasıyla açar); Telegram'daki "Uygulamada aç" bağlantıları da aynı kurallarla çalışır.

### CV ve portföyün İngilizce sürümleri

- **İngilizce sürüm.** Profilim › CV ve portföy bölümünde CV ve portföyün İngilizce sürümleri ayrıca yüklenebilir.
- **Ekler yazının diline uyar.** Başvuru yazısı önizlemede İngilizceye çevrildiğinde ekler kendiliğinden İngilizce sürümlere geçer, Türkçeye döndürülünce Türkçe sürümlere döner. İngilizce sürümü olmayan ek (ya da elle eklenmiş başka belge) olduğu gibi kalır. Önizlemedeki ek listesinde İngilizce dosyalar işaretlenir.
- **Türkçe esas.** Otomatik başvuru, varsayılan ekler, kurulum ekranı ve CV'den bilgi çıkarma, İngilizce sürüm daha yeni yüklenmiş olsa da Türkçe sürümü kullanır; arşivlenen bir ekin yerine aynı dildeki güncel sürüm konur.
- **Geçiş.** Veritabanı değişikliği yok (belgelerdeki dil alanı zaten vardı).

### İş alarmı mailleri

- **İş sitelerinin kendi bildirimi ilan kaynağı oldu.** Kariyer.net, Indeed, Yenibiris gibi siteler arama ve ilan sayfalarını otomatik taramaya kapatıyor (doğrulama engeli); AI web araması da bu ilanların ancak bir kısmını görebiliyor. Kullanıcı bu sitelerde iş alarmı kurduğunda sitenin gönderdiği ilan mailleri artık gelen kutusu taramasında okunur, içindeki ilanlar çıkarılır ve arama profiline (unvan, konum, kapsam) uyanlar "İş alarmı" kaynağından açık ilan olarak eklenir; firma listede yoksa oluşturulur. Tanınan siteler: Kariyer.net, LinkedIn, Indeed, Glassdoor, Secretcv, Eleman.net, Yenibiris, Youthall, Toptalent, İşin Olsun, Jooble.
- **Nasıl okunur.** Posta saklanmaz. Bağlantıları numaralanır (`L1`, `L2`…), metni hafif modelle okunur; model ilanı adresle değil numarayla gösterir, postada olmayan bağlantıya işaret eden ilan atılır. Tıklama sayacı bağlantıları ilan adresine kadar izlenir, ilan sayfasının kendisine istek atılmaz. Hesap, şifre, başvuru onayı ve mesaj bildirimleri yapay zekâya gitmeden elenir.
- **Dayanıklılık.** Yapay zekâ o an kullanılamıyorsa bildirim bekletilir ve sonraki taramalarda yeniden denenir. Görev "gelen kutusu" öncelik sınıfında sayılır.
- **Arayüz.** Mail dönüşleri sekmesine "İş alarmları" paneli eklendi: okunan alarm maili ve eklenen ilan sayısı, son mail zamanı ve site başına alarm kurma adımları. Gelen kutusu takibi, başvurusu olmayan hesaplarda da (yalnızca alarm mailleri için) çalışır.
- **Alarm kurulumu.** İş alarmları panelinde sitelerin alarm durumu tek satırda görünür (çalışıyor / kurulmadı). Alarm kurmak için profildeki pozisyonlardan bir ya da birkaçı ve istenen şehirler seçilir; şehir listesi 81 ili ve İstanbul'un Anadolu ve Avrupa yakalarını içerir, yazarak aranır ve çoklu seçilir (profildeki şehirler yalnızca başlangıç seçimidir). Her şehir için LinkedIn ve Indeed butonu aramayı yeni sekmede açar; kullanıcı alarmı kendi hesabıyla kurar (uygulama siteye bağlanmaz). LinkedIn ve Indeed seçilen pozisyonları "VEYA" ile tek aramada birleştirir ve İstanbul'un yakalarını ayırmaz (İstanbul geneli aranır); Kariyer.net tek pozisyonla açılır, şehir ve yaka orada sayfadaki filtreden seçilir. Üç sitede de alarm çalışınca kurulum bölümü kapanır. Siteden ilk alarm maili geldiğinde site "çalışıyor" olarak işaretlenir.
- **Geçiş.** Veritabanı değişikliği yok. Yalnızca dağıtımdan sonra gelen alarm mailleri okunur.

### Kaldırılanlar
- **Eski Flutter yönetici arayüzü** (`app/`, `/legacy/`) kaldırıldı; menüdeki "Gelişmiş yönetici görünümü" bağlantıları da gitti. Web imajı artık yalnızca React arayüzünü içerir ve Flutter derlemesi gerektirmez. Yalnızca eski arayüzde olan ekranlar (kaynak yönetimi, kampanyalar, Excel içe aktarma, Gmail OAuth bağlama, ayrıntılı taslak ve ilan ekranları) arayüzsüz kaldı; uçları API'de duruyor. Bu ekranlara giden bildirim bağlantıları ana sayfayı açar.

### v1.1 Faz 5 — öğrenen sistem ([yol haritası](docs/ROADMAP.md))

- **Kendi verimizle eğitilen modeller.** Her gece deneyim defterinden üç hafif model eğitilir: adresin mail alıp almayacağı (teslim), firmanın yanıt verip vermeyeceği (yanıt) ve kullanıcının hangi fırsatlara başvurduğu (ilgi). Sunucuda çalışırlar, yapay zekâ hakkı harcamazlar.
- **Önce kanıt, sonra kullanım.** Bir model, eğitimde görmediği örneklerde temel orandan iyi tahmin etmedikçe etkinleşmez ve hiçbir sıralamayı değiştirmez. İlk eğitimde veri az olduğu için modeller henüz pasif; veri biriktikçe kendiliğinden devreye girerler.
- **Alıcı sıralaması.** Teslim modeli etkinken varsayılan alıcı seçimi, önizlemedeki adres sırası ve otopilotun "sıradaki adres" seçimi adresin ulaşma olasılığını hesaba katar: aynı türdeki adreslerden olasılığı yüksek olan öne geçer. Daha önce ulaştığı görülen adres her zaman güvenilir sayılır. Gönderim anındaki kestirim kayda yazılır.
- **Fırsat sıralaması.** Yanıt ve ilgi modelleri etkinleştiğinde Firmalar listesinde aynı sınıftaki firmalar yanıt alma olasılığına göre sıralanır.
- **Deneyim istemlere giriyor.** Adres araması, geçmiş gönderimlerde hangi kaynaktaki adreslerin ulaştığını ipucu olarak alır (örneğin firmanın kendi sitesindeki adresler üçüncü taraf sitelerdekilerden daha sık ulaşıyor). Keşif, yanıt veren firmaların ortak sektör ve büyüklüğünü; yazı hazırlama, adayın yanıt almış başvurularındaki paragrafları ton örneği olarak alır.
- **Öğrenme ekranı (yönetici).** Profilim'de biriken kayıtlar, her modelin durumu (örnek sayısı, isabet, neden kullanılmadığı), en etkili özellikler, haftalık gönderim sonuçları ve istemlere eklenen ipuçları görünür; "Şimdi eğit" ile elle eğitilebilir.
- **Veri seti.** Yapay zekâ görevlerinin istemi, kabul edilmiş çıktısı ve gerçek sonucu JSONL olarak indirilebilir (ileride küçük bir modelin ince ayarı için).

### v1.1 Faz 4 — otopilot ve yapay zekâ kullanımı ([yol haritası](docs/ROADMAP.md))

- **Otopilot.** Geri dönen başvuru için karar artık kendiliğinden verilir. Adres geçersizse aynı yazı firmanın doğrulanmış sıradaki İK adresine gider; bilinen adres yoksa geçersiz adresler dışında bir kez yeni adres aranır; firma başka adres bildirdiyse oraya gönderilir; ekler sığmadıysa yalnızca CV ile, kutu doluysa üç gün sonra yeniden denenir; firma biçim istediyse yazı ona göre düzenlenir. "Kariyer sitesinden başvurun" diyen firmaya mail yeniden gönderilmez, bağlantısı gösterilir.
- **Onay ve sınırlar.** "Otomatik başvur" açıkken düzeltmeler bir sonraki gönderim penceresinde kendiliğinden gider; kapalıyken öneri olarak bekler ve tek tıkla onaylanır. Kendiliğinden gönderim yalnızca firmanın doğrulanmış İK ya da ilan başvuru adresine yapılır; genel iletişim adresi, bir çalışanın adresi ve nedeni belirsiz dönüşler her zaman onay ister. Bir başvuru en çok iki kez kendiliğinden düzeltilir. Acil durdurma ve "Otomatik başvur"un kapatılması sıradaki düzeltmeleri de durdurur; gönderilemeyen düzeltme yeniden öneriye döner.
- **Otopilot paneli.** Mail dönüşleri sekmesinde "Otomatik düzelt" panelinin yerini aldı: zincirin aşamalarındaki sayılar (firma, adresi bilinen, yazısı hazır, gönderilen, ulaşan, geri dönen, yanıt gelen), onay bekleyen öneriler ve yapılanların günlüğü (ne yaptı, neden, kaç yapay zekâ görevi harcadı). Otopilottan önce gelmiş açık dönüşler için öneriler yapay zekâ harcanmadan hazırlanır.
- **Adres araması hatırlar.** Bir firma için yapılan arama derinliğiyle birlikte kaydedilir; aynı derinlikteki arama 30 gün (kullanıcı ısrar ederse 7 gün) tekrarlanmaz, derinleştirme kaldığı basamaktan sürer. İK adresi bulununca durulur; yalnızca genel adres bulunduysa bir ikinci görüş alınır, en güçlü modele ancak hiç adres çıkmadıysa çıkılır. Derin araması sonuçsuz kalan firmada yalnızca diğer başvuru kanalları gösterilir.
- **Yapay zekâsız teyit.** Kaynağında doğrulanmış adresler 30 günde bir yeniden aranmak yerine yayımlandıkları sayfa okunarak teyit edilir; ulaştığı bilinen adres doğrulanmış kalır. Gece turu yalnızca hâlâ başvurulabilecek firmaların raporunu yeniler.
- **Öncelik sınıfları.** Yapay zekâ görevleri beş sınıfta sayılır: senin başlattığın işlemler, mail dönüşü düzeltme, yazı hazırlama, araştırma, keşif. Günlük hak ya da abonelik kullanım penceresi daraldıkça önce keşif ve araştırma durur; durum paneli neyin ne zamana kadar bekletildiğini söyler. Sınıfı kapalı arka plan işi başlatılmaz (şablon çıktısı ya da bekleyen görev üretmez). Çıktısı kurallara uymayan hafif model bir üst modelle bir kez yeniden denenir; kuralla tanınan otomatik yanıtlar için yapay zekâya sorulmaz.
- **Bildirimler.** Otopilotun her kararı ve olumsuz yanıtlar bildirilir; bildirim doğrudan Mail dönüşleri sekmesini açar.
- **Geçiş.** Veritabanına yalnızca `AutopilotAction` tablosu eklenir.

### v1.1 Faz 3 — ilan arama motoru ([yol haritası](docs/ROADMAP.md))

- **İlan araması.** Uygulama artık firmaların kariyer sayfalarını beklemeden, aradığın ve yakın unvanlar için açık ilanları web aramasıyla bulur: LinkedIn, Indeed, Kariyer.net, yerel ilan siteleri ve firma kariyer sayfaları. Her gece birkaç sorgu çalışır; "Yeniden ara" hemen bir tur başlatır. Bu platformlara oturum açan ya da arama sayfalarını kazıyan bot yoktur; ilana "LinkedIn'de başvur" gibi butonlarla kendi hesabınla gidersin.
- **Tekrarsız sonuç.** Aynı ilanın farklı bağlantıları (izleme parametreleri, LinkedIn/Indeed ilan numarası) tek ilana iner; ikinci tarama ilk taramanın getirdiğini yeni saymaz, bilinen ilanlar aramaya "bunları tekrar yazma" diye verilir. Firma adının varyantları ("Trendyol Group") aynı firmaya bağlanır.
- **Öğrenen sorgu sırası.** Unvan grubu × kaynak kümesi başına sorgunun verimi tutulur: yeni ilan getirmeyen sorgu her seferinde iki kat uzun dinlenir, verimli olan ertesi gün yeniden çalışır.
- **Doğrulama.** Bulunan ilan sayfası izin veriyorsa okunur: kapanmış ilan alınmaz, açık olduğu görülen ilan açık, sayfası okunamayan (ör. LinkedIn) ilan "Açıklığı teyit edilmeli" olarak listelenir. Web aramasıyla bulunan ilanlara otomatik başvuru yapılmaz; elle başvurabilirsin. Bir süredir yeniden görülmeyen ilan yoklanır ve kapanmışsa "geçmişte açmış" sınıfına geçer.
- **Hedefli tarama.** Arama kutusuna yazdığın metinle ("Ankara fintech iOS") tek seferlik ilan taraması başlatabilirsin.
- **Yurt dışı kapsamı.** Profilde iki yeni seçenek: yurt dışındaki firmaların Türkiye'den çalışılabilen uzaktan ilanları (Remotive, Remote OK, Himalayas panoları ve web araması) ve taşınmayı gerektiren ilanlar (ülke/şehir tercihiyle; Arbeitnow ve web araması). Firmalar sekmesinde "Türkiye / Uzaktan / Yurt dışı" filtresi ve ilan satırında kapsam etiketi var. Bölgesi Türkiye'ye kapalı uzaktan ilanlar ("USA only") alınmaz.
- **Altı yeni başvuru panosu.** Greenhouse ve Lever'a ek olarak Workable, SmartRecruiters, Recruitee, Ashby, Teamtailor ve Personio panoları firmanın resmî ilan kaynağı olarak izlenir.
- **Türkçe-İngilizce unvan eşlemesi.** "Mobil Uygulama Geliştirici" ilanı "Mobile Developer" aramasıyla, "Sosyal Medya Uzmanı" ilanı "Social Media Specialist" aramasıyla eşleşir.

### v1.1 Faz 2 — ortak hafıza ve adres bilgisi ([yol haritası](docs/ROADMAP.md))

- **Ortak firma kataloğu.** Bir kullanıcının bulduğu firmanın kamuya açık bilgileri (site, ofis, yayımlanmış başvuru adresleri, kariyer kaynakları, görülen ilanlar, çalışan sayısı) çalışma alanlarından bağımsız bir katalogda birikir. Yeni bir hesap pozisyonlarını kaydettiğinde, katalogda aynı unvan ailesi için bulunmuş ve aynı şehirdeki firmalar yapay zekâ çağrısı yapılmadan listesine eklenir; "N firma ortak listeden eklendi" bildirimi gelir. Kimin başvurduğu, notlar, yazılar ve role özel analiz paylaşılmaz.
- **Önce ortak hafıza, sonra arama.** Mail adresi aramadan önce kataloğa bakılır; başka bir kullanıcıda bulunmuş adres varsa arama yapılmaz. Her gece katalogdaki yeni adres, ofis ve çalışan sayısı bilgisi diğer hesaplara dağıtılır.
- **Adres sicili.** Her adres için gönderim, teslim, geri dönüş ve yanıt sayısı tutulur. Yanıt ya da otomatik yanıt gelen, ya da 72 saat içinde geri dönmeyen adres "ulaşıyor" sayılır: doğrulanmış kabul edilir ve başvuru önizlemesinde "daha önce ulaştı" diye işaretlenir.
- **Geçersiz adres bir daha seçilemez.** "Adres bulunamadı", "adres dışarıdan mail almıyor" ya da "alan adı mail almıyor" dönüşü adresi tüm hesaplarda kalıcı olarak kapatır: seçeneklerden kalkar, elle yazılsa da gönderilmez, yeniden bulunsa da kaydedilmez ve o firmanın sonraki aramalarında "bu adreslerin dışındakileri ara" diye verilir. Tekrar gönderimde geri dönmüş adresi yeniden açma davranışı kaldırıldı.
- **Çalışan sayısı ve filtresi.** Firma kartlarında çalışan sayısı aralığı görünür; Firmalar sekmesinde 1-10, 11-50, 51-200, 201-1.000, 1.000+ ve "Bilinmiyor" filtreleri var (birden fazlası birlikte seçilebilir). "Bilinmeyenleri bul" eksikleri 12'lik gruplar halinde arar; gece turu da her gün bir bölümünü tamamlar.
- **Deneyim defteri.** Her gönderim, adres araması, keşif ve çalışan sayısı araması özellikleri ve sonucuyla kaydedilir (ileride kendi verimizle eğitilecek modeller için). Geçmiş gönderimler de işlenir.
- **Geçiş.** Veritabanı yalnızca yeni tablo ve sütun ekler. İlk çalıştırmada worker mevcut firmaları kataloğa, geçmiş gönderimleri ve dönüşlerini sicile bir kez işler.

### v1.1 Faz 1 — arayüz toparlama ve kontrol ([yol haritası](docs/ROADMAP.md))

- **Yeni ad ve logo: Jobless Turtle.** Sekme başlığı, favicon, PWA ikonları, giriş ekranı ve tema rengi yenilendi; Flutter logosu kalktı.
- **Arayüz React'e taşındı** (`web/`: React + TypeScript + Tailwind). Giriş, kurulum sihirbazı, ana ekran, profil ve bildirimler yeniden yazıldı; ilk açılışta inen veri yaklaşık 2,4 MB'tan (Flutter betiği + CanvasKit) 0,3 MB'a indi (brotli; betik 150 KB). Açık/koyu/sistem teması, telefon düzeni ve klavye erişimi var. Eski gelişmiş yönetici arayüzü `/legacy/` altında çalışmaya devam eder; oturum iki arayüz arasında paylaşılır.
- **Üç sınıf:** başvurulmamış firmalar "açık ilanı olan", "bu pozisyonu daha önce açmış" ve "pozisyon açma potansiyeli olan" olarak gruplanır. Aranan ya da yakın unvanla eşleşmeyen ilanlar ve "diğer N ilanı gör" kaldırıldı.
- **Başvurulan firmalar** "Firmalar" sekmesinde hiçbir koşulda listelenmez; "Diğer firmalar" başlığı ve "başvurduklarımı da göster" anahtarı kalktı.
- **Durum paneli gerçek işi gösterir:** çalışan iş varken hangi iş ve kaç tane (çalışan/sırada); yokken "Beklemede" ve sıradaki otomatik tarama, gece keşfi, yazı hazırlama turu. Kuyruk boşken gösterge dönmez. Worker yanıt vermiyorsa bu da söylenir. Günlerce "çalışıyor" görünen yarım kalmış AI görevleri kendiliğinden kapatılır.
- **Her sekmede arama, filtre ve sıralama:** Firmalar'da tek kutu firma adı, pozisyon, şehir, ilçe, sektör, site ve alıcı adresinde arar (Türkçe karakter duyarsız, çok kelimeli); sınıf, bölge, mail adresi ve yazı durumu filtreleri ile üç sıralama var. Filtreler adres çubuğunda tutulur. Başvurularım'da arama, teslim durumu, tarih aralığı ve sıralama; Mail dönüşleri'nde arama ve tür filtresi. Seçim ve toplu işlem çubuğu kaydırırken üstte kalır.
- **Başvuru kanalı butonları:** ilanın başvuru formu, platform kopyaları (LinkedIn, Kariyer.net, Indeed…), firmanın mail yanıtında istediği başvuru sayfası ve kariyer sayfası ayrı buton olarak görünür; ardından "Başvurdum" ile işaretlenir.

### Değişenler
- **Unvan odaklı firma keşfi** birincil akış oldu: arama profili kaydedilince/unvanları değişince ve her gün (varsayılan açık) tüm hedef/yakın unvanlar, bölge ve sektörlerle yeni firma aranır; açık rolü olan firmalar öncelikli. Bulunan firmanın resmî kariyer sayfası ve Greenhouse/Lever panosu otomatik kaynak olur, görülen roller firma notuna sinyal olarak yazılır.
- Günlük keşif ayarı ve profil başına firma sayısı AI bağlantıları ekranında; Özet ekranında "Unvanlara göre firma keşfet" düğmesi.
- Excel içe aktarma isteğe bağlı hale getirildi (yalnızca hazır listesi olanlar için).

### Düzeltilenler
- Web Docker derlemesi `ghcr.io/cirruslabs/flutter:stable` (Dart 3.12) yerine sabitlenmiş Flutter 3.47.5 / Dart 3.13.4 ile, root olmayan kullanıcıyla yapılır; `docker compose up -d --build` artık `pubspec.lock` SDK kısıtı nedeniyle başarısız olmaz.

## 1.0.0 — 30 Eylül 2026

İlk sürüm: web MVP ve arkadaş pilotu (geliştirme dokümanı v1.1, P0).

### Eklenenler
- **Backend** (NestJS, Prisma, PostgreSQL, Redis/BullMQ): API ve ayrı worker süreci, outbox tabanlı olay dağıtımı, zamanlayıcı.
- **Veri modeli**: workspace/kullanıcı ayrımı, aday ve arama profilleri, kaynak, gözlem, firma/ofis/kanıt, ilan/listing/snapshot, fırsat, iletişim, mail hesabı, belge sürümü, taslak sürümü, politika sürümü, başvuru denemesi, kampanya, takip, outbox/denetim, yanıt, bildirim, kara liste, AI görevi.
- **Kaynaklar**: Greenhouse, Lever, firma kariyer sayfası (JSON-LD/HTML, robots), demo kaynak; LinkedIn/Indeed/Glassdoor/Kariyer.net için manuel kayıt.
- **İlan yaşam döngüsü**: yeni/değişen/kapanan/yeniden açılan ilanlar, resmî kaynak önceliği, çelişki kaydı, 403/429/timeout'ta kapanış yok.
- **Firma araştırması**: izinli sayfa okuma, kariyer/ATS bağlantılarının otomatik kaynak olması, kaynaklı rapor, Q/kapsam, günlük keşif ve haftalık güncelleme.
- **Puanlama**: açıklanabilir Q (35/25/15/15/10) ve F (35/20/20/25), fırsat kategorileri.
- **Başvuru**: sürümlü taslak, tekil/toplu gönderim, idempotency, tekrar engeli, satır kilidi, limit rezervasyonu, belirsiz sonuçta otomatik tekrar yok, platformda tamamla.
- **Otomasyon**: sürümlü politika, ilan/niyet/takip anahtarları, eşikler, limitler, gönderim penceresi, dry run, acil durdur, 7 iş günü takip.
- **E-posta**: Gmail OAuth (`gmail.send`), SMTP, test sağlayıcısı.
- **Bildirim**: uygulama içi, Telegram (tek kullanımlık kodla bağlama), günlük özet, sessiz saatler.
- **AI köprüsü**: Claude Code CLI, Codex CLI, manuel kopyala-yapıştır, Ollama, isteğe bağlı API, şablon; şema ve kaynak doğrulaması.
- **Excel**: sütun eşlemeli içe aktarma, CSV/XLSX dışa aktarma.
- **Güvenlik**: şifreli token/parola, SSRF koruması, dosya taraması, webhook imzası, formül kaçışı, workspace sınırı.
- **Flutter web arayüzü**: 13 ana ekran + detay sayfaları, 390/768/1440 px responsive.
- **Operasyon**: Docker Compose (Caddy, API, worker, PostgreSQL, Redis, isteğe bağlı Cloudflare Tunnel), yerel çalıştırma, yedekleme/geri yükleme betikleri.
- **Testler**: birim testleri, gerçek veritabanıyla e2e senaryoları, Flutter widget testleri, CI iş akışı.
