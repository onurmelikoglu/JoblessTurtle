# Değişiklik günlüğü

## Yayımlanmamış (dev)

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
- **Alarm kurulumu.** İş alarmları panelinde sitelerin alarm durumu tek satırda görünür (çalışıyor / kurulmadı). Alarm kurmak için profildeki pozisyonlardan bir ya da birkaçı ve şehir seçilir, site butonu aramayı yeni sekmede açar; kullanıcı alarmı kendi hesabıyla kurar (uygulama siteye bağlanmaz). LinkedIn ve Indeed seçilen pozisyonları "VEYA" ile tek aramada birleştirir (ör. Türkçe ve İngilizce adı); Kariyer.net tek pozisyonla açılır ve şehir orada sayfadan seçilir. Üç sitede de alarm çalışınca kurulum bölümü kapanır. Siteden ilk alarm maili geldiğinde site "çalışıyor" olarak işaretlenir.
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
