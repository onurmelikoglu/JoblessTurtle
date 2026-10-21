# Mimari

## Bileşenler

```
 Tarayıcı / telefon ──HTTPS──▶ Cloudflare Tunnel (isteğe bağlı)
                                   │
                          ┌────────▼────────┐
                          │ web (Caddy)     │  React arayüzü (/), /api ters vekil
                          └────────┬────────┘
                                   │ /api
                          ┌────────▼────────┐        ┌──────────────┐
                          │ api (NestJS)    │───────▶│ PostgreSQL   │ kalıcı kayıtlar, benzersizlikler
                          └────────┬────────┘        └──────▲───────┘
                     OutboxEvent   │                        │
                          ┌────────▼────────┐               │
                          │ worker (NestJS) │───────────────┘
                          │ BullMQ kuyrukları│◀──────▶ Redis (kuyruk, zamanlayıcı kilidi, canlı olay yayını)
                          └────────┬────────┘
            ┌──────────────┬───────┴───────┬───────────────┬──────────────┐
         İlan kaynakları  Firma siteleri  Mail sağlayıcı  Telegram      AI köprüsü
         (Greenhouse,     (izinli sayfa,  (Gmail API,     Bot API       (claude/codex CLI,
          Lever, JSON-LD)  robots)         SMTP, Fake)                   manuel, Ollama, API)
```

- **API ve worker ayrı süreçlerdir**, aynı backend imajından farklı komutla başlar (`docker-entrypoint.sh api|worker`).
- API iş verisini ve olayı **aynı transaction** içinde yazar (`OutboxEvent`). Worker dağıtıcısı olayları `FOR UPDATE SKIP LOCKED` ile sahiplenip BullMQ kuyruklarına aktarır; olaylar en az bir kez işlenebilir kabul edilir ve işleyiciler idempotenttir.
- Kuyruklar: `collect`, `research`, `interactive`, `evaluate`, `automation` (taslak/otomasyon), `send`, `reconcile`, `notify`, `inbox`.
- Zamanlayıcı Redis kilidiyle tek lider olarak çalışır; kaynakları kendi aralıklarına göre (API 10 dk, HTML 30–60 dk) kuyruğa alır. Her tur tüm kaynaklara istek atıldığı anlamına gelmez.

## Arayüz

- **`web/` (React + TypeScript + Tailwind)** herkesin kullandığı arayüzdür: giriş, kurulum sihirbazı, ana ekran (Firmalar, Başvurularım, Mail dönüşleri), profil ve bildirimler. Sunucu durumu TanStack Query ile 20 saniyede bir yenilenir; sekme ve filtreler adres çubuğunda tutulur.
- **Yanıt sözleşmesi** `backend/src/contracts/` altındadır. Sunucudaki servis metotları bu tipleri `ServerShape<…>` ile uygular (tarih alanları sunucuda `Date`, JSON'da ISO metin); web aynı dosyaları yalnızca tip olarak içe aktarır. Sözleşme değişirse iki taraf da derlenmez.
- **Eski `#/…` bağlantıları** (Telegram bildirimi, Gmail yetkilendirme dönüşü) `web/src/legacy-links.ts` ile yeni adreslerine gider. İlk sürümdeki Flutter yönetici arayüzü 14 Ekim 2026'da kaldırıldı; kaynak kodu git geçmişinde durur.

## Ana ekranın kuralları

- **Firma sınıfı** (`domain/company-class.ts`): başvurulmamış her firma tek sınıfa düşer — *açık ilan* (hedef/yakın unvanda açık ya da açıklığı teyit edilemeyen ilan), *geçmişte açmış* (ilgili ilan kapanmış), *potansiyel* (ilgili ilan görülmemiş). Başvurulan firma ve görünür fırsatı kalmayan firma listelenmez; unvanla eşleşmeyen ilanlar arayüze hiç gönderilmez.
- **Durum paneli** (`domain/activity.ts`, `engine/activity.service.ts`): durum birikmiş işe değil gerçek işe bakar. Worker 10 saniyede bir kuyruklardaki çalışan ve bekleyen işleri çalışma alanı başına yazar; API buna çalışan AI görevlerini, gönderilmekte olan mailleri ve henüz dağıtılmamış olayları ekler. Zamanlanmış kaynak taraması, gönderim ve gelen kutusu kontrolü durumu "çalışıyor" yapmaz. Sağlayıcı zaman aşımından uzun süre `running` kalan AI görevi 10 dakikada bir temizlenir.
- **Başvuru kanalları** (`domain/apply-links.ts`): ilanın formu, platform kopyaları (LinkedIn, Kariyer.net, Indeed…), firmanın mail yanıtında verdiği bağlantı ve kariyer sayfası ayrı buton olur. Yalnızca http(s) bağlantıları geçer.

## Ortak hafıza

Çalışma alanları birbirinin verisini göremez; paylaşılan tek şey aşağıdaki dört tablodur ve yalnızca kamuya açık firma bilgisi ile adres teslim sonuçlarını içerir. Kimin başvurduğu, notlar, taslaklar ve role özel firma analizi paylaşılmaz.

| Tablo | İçerik | Kurallar |
|---|---|---|
| `CatalogCompany` | Firma kimliği (alan adı; yoksa sadeleştirilmiş ad), site, kariyer sayfası, sektörler, ofisler, yayımlanmış adresler, kariyer kaynakları, görülen ilanlar, firmanın hangi unvanlar aranırken bulunduğu, çalışan sayısı | `domain/catalog.ts`, `engine/catalog.service.ts` |
| `AddressRecord` | Adres başına gönderim/teslim/geri dönüş/yanıt sayısı, durum (`unknown` / `deliverable` / `dead`), ilk bulunduğu kaynak | `domain/address-book.ts`, `engine/address-book.service.ts` |
| `DeadDomain` | Mail almadığı kesinleşen alan adları | aynı |
| `LearningEvent` | Deneyim defteri: yapılan iş (özellikler) ve sonucu | `domain/learning.ts`, `engine/learning.service.ts` |

- **Yukarı (publish).** Firma her değerlendirildiğinde, araştırıldığında ya da adresi/çalışan sayısı bulunduğunda paylaşılabilir bilgisi katalogla birleştirilir: kimlik alanlarında ilk değer korunur, listeler birleşir, geçersiz adresler çıkarılır.
- **Aşağı (pull / seed).** Adres aramasından önce ve her gece, çalışma alanındaki firmanın eksikleri (adres, ofis, çalışan sayısı) katalogdan tamamlanır. Profil kaydedilince ve her gece, unvan sinyali olan ve aynı şehirdeki katalog firmaları çalışma alanına eklenir; bu adımların hiçbiri yapay zekâ çağırmaz.
- **İş alarmı mailleri** (`domain/job-alerts.ts`, `engine/job-alerts.service.ts`): gelen kutusu taraması, gönderilmiş başvurularla eşleşen postaların yanında bilinen iş sitelerinden gelenleri de alır. Konusu ve bağlantıları ilan bildirimine benzeyen posta saklanmadan okunur: bağlantılar `L1…Ln` diye numaralanır, `job_alert` görevi (hafif model, `fix` sınıfı) ilanları numarayla döndürür, tıklama sayacı bağlantıları `resolveRedirects` ile ilan adresine kadar izlenir (ilan sayfası istenmez) ve sonuç `JobSearchService.applyListings` ile `job_alert` kaynağına yazılır; profil eleme kuralları AI aramasıyla aynıdır, yalnızca sayfa doğrulaması atlanır (siteler engelliyor). Yapay zekâ kullanılamazsa bildirim `jobalert:pending:<hesap>` anahtarında bekler; sayaçlar `jobalert:stats:<çalışma alanı>` anahtarındadır.
- **Adres durumu.** Gönderim sağlayıcıda kabul edilince sicile işlenir; mail dönüşü geldikçe güncellenir. Yalnızca sunucunun kesin bildirdiği hatalar (`bad_address`, `closed_address`, `bad_domain`) adresi kalıcı olarak geçersiz kılar; geçersiz adres tüm çalışma alanlarında kapatılır ve hiçbir yoldan (seçim, elle giriş, yeniden bulunma, ilanın başvuru adresi) geri gelmez. Gelen kutusu izlenen hesapta 72 saat geri dönmeyen mail ulaşmış sayılır; geç gelen geri dönme bunu düzeltir.
- **Geçiş.** `catalog:backfill:v1` anahtarı yokken worker mevcut firmaları ve gönderim geçmişini bir kez işler; işlem yeniden çalıştırılabilir.

## İlan arama motoru

İlanlar dört yoldan gelir; hepsi aynı kayıt hattına (`IngestService`) girer ve firma + sadeleştirilmiş unvan + bölge üzerinden tek ilanda birleşir.

| Yol | Nasıl | Durum ve otomasyon |
|---|---|---|
| Firmanın resmî kaynağı | Kariyer sayfası (JSON-LD) ve başvuru panoları: Greenhouse, Lever, Workable, SmartRecruiters, Recruitee, Ashby, Teamtailor, Personio (`engine/connectors/`, tanıma: `ats-detect.ts`) | Resmî kanıt; açık/kapalı ve tazelik buradan gelir, otomatik başvuru yalnızca bununla mümkündür |
| İlan panoları | Remotive, Remote OK, Himalayas (uzaktan), Arbeitnow (taşınma) herkese açık API'leri (`connectors/boards.ts`); yalnızca profil yurt dışı kapsamını açtıysa etkin | Toplayıcı: açık görünür ama otomatik başvuruya girmez |
| İlan sitesi taraması | Kariyer.net ve Indeed'in oturumsuz arama sayfaları; ortak `ScrapedJob` kaydı, profile uyan yeni ilanlar çalışma alanına aktarılır (`engine/scraper.service.ts`, [SCRAPERS.md](SCRAPERS.md)) | Toplayıcı: site ilanı listede gösterdiği için açık kabul edilir; otomatik başvuruya girmez |
| Web araması | `job_search` AI görevi: unvan grubu × kaynak kümesi (LinkedIn/Indeed, Kariyer.net ve yerel siteler, firma sayfaları ve panolar, yurt dışı) (`engine/job-search.service.ts`) | Sayfası okunup doğrulanan ilan açık, okunamayan "teyit gerekli"; otomatik başvuruya girmez |

- **Oturum ve atlatma yok.** LinkedIn, Indeed, Kariyer.net gibi sitelere oturum açılmaz. Kariyer.net ve Indeed'in yalnızca herkese açık arama sayfaları taranır (robots.txt, istek aralığı, engelde durma; bkz. [SCRAPERS.md](SCRAPERS.md)). Web aramasında model yalnızca gördüğü ilanı bağlantısıyla döndürür; ilan sayfası ancak robots.txt izin veriyorsa okunur.
- **Sorgu planlayıcı** (`domain/job-search.ts`): aranan unvanlar ikişerli, yakın unvanlar beşerli gruplanır; her grup her kaynak kümesinde ayrı sorgudur. Sorgunun verimi (`jobsearch:log:<profil>`) tutulur: hiç çalışmamış sorgu önce gelir, yeni ilan getirmeyen sorgu 1, 2, 4, 8 gün dinlenir. Gece turu profil başına 4, "Yeniden ara" 6 sorgu çalıştırır.
- **Tekilleştirme.** Bağlantı sadeleştirilir (izleme parametreleri atılır, LinkedIn/Indeed'de ilan numarası esas alınır) ve bu anahtarla aynı ilan ikinci kez kaydedilmez. Firma önce alan adıyla, sonra adla, sonra adın çekirdeğiyle ("… Group", "… Teknoloji") eşlenir. Yeni firma keşif akışına girer (araştırma, adres arama, ortak katalog).
- **Uygunluk süzgeci.** Toplayıcı kaynaktan gelen ilan ancak aranan/yakın unvanla eşleşiyorsa ve kapsamı profile uyuyorsa kaydedilir: uzaktan ilan Türkiye'ye açık olmalı, taşınma ilanı tercih edilen bölgede olmalı.
- **Eskime.** Toplayıcı ilan 10 gün yeniden görülmezse sayfası yoklanır; kapanmışsa ya da 30 gün yoklanamadıysa kapanır ve firma "geçmişte açmış" sınıfına geçer.

## Otopilot

Gönderilen başvuruya dönen her mail (`InboxService.store`) `autopilot.inbound` olayı üretir; `AutopilotService` dönüşü kurallarla karara bağlar (`domain/autopilot.ts`, saf ve birim testli) ve sonucu `AutopilotAction` kaydına yazar. Kayıt hem onay kuyruğu hem de günlüktür.

| Dönüş | Karar | Yapay zekâ |
|---|---|---|
| Adres yok / dışarıya kapalı / alan adı geçersiz | Firmanın sıradaki adresine aynı yazı; yoksa geçersizler dışında tek arama; yine yoksa dur | Yalnızca aramada |
| Firma başka adres bildirdi | O adrese aynı yazı | Yok |
| Ek boyutu | Aynı adrese yalnızca CV | Yok |
| Kutu dolu | Üç gün sonra aynı adres; yine doluysa diğer adres | Yok |
| Biçim talimatı | Yazı talimata göre düzenlenir (`inbound_fix`) | Var |
| "Kariyer sitesinden başvurun" | Mail durur; bağlantı gösterilir | Yok |
| Sunucu reddi, nedeni belirsiz dönüş | Öneri; onaylanınca yapay zekâ maili okuyup karar verir | Onaydan sonra |
| Firma yanıtı, ulaştı bildirimi, gecikme | Düzeltme yok (takip iptali ve bildirim ayrı işler) | — |

- **Mod.** Çalışma alanında "Otomatik başvur" açık bir politika varsa `auto`, yoksa `approval`, acil durdurma açıksa `stopped`. Yalnızca dönüşün geldiği anda ve `auto` modda kendiliğinden gönderilir; diğer her durumda öneri (`proposed`) kaydedilir. Karar verilmemiş açık dönüşler altı saatte bir taranır; tarama yapay zekâ harcamaz ve hiçbir şey göndermez.
- **Kendiliğinden gönderimin koşulları.** Gönderim `autopilot` modunda sıraya girer: alıcı firmanın kayıtlı ve doğrulanmış adresi olmalı, türü politikanın izin verdiği türlerden (varsayılan İK ve ilan başvuru adresi) olmalı, ilan başvurusunda ilan açık olmalı. Karşılanmayan koşul gönderimi öneriye çevirir. Zincirde iki otomatik düzeltme varsa üçüncüsü yapılmaz. Worker gönderimden hemen önce acil durdurmayı ve "Otomatik başvur"un hâlâ açık olduğunu yeniden okur.
- **Geri alınan düzeltme.** İptal edilen ya da engellenen yeniden gönderim, yerine geçtiği dönüşü yeniden açar ve kararı öneriye döndürür; dönüş "tekrar gönderildi" görünüp sahipsiz kalmaz.
- **Onay.** `POST /v1/home/autopilot/approve` öneriyi `running` yapar ve işi kuyruğa bırakır; uygulama kullanıcının adına ve "etkileşimli" yapay zekâ sınıfında yürür. Elle yeniden gönderim ve "çözüldü" işareti açık öneriyi kapatır.

### Adres aramasının hafızası

`domain/contact-search.ts`: firma başına son aramanın zamanı ve derinliği (`base` → `second` → `max`) `researchMeta` içinde tutulur. Aynı derinlik 30 gün (kullanıcı açıkça isterse 7 gün) tekrarlanmaz; derin arama yalnızca denenmemiş basamaklardan sürer; bir adresin geri dönmesinden sonraki arama öncekinden bağımsız sayılır. Basamak sonunda güvenilir İK adresi varsa durulur, yalnızca genel adres varsa tek ikinci görüş alınır. Kaynağında doğrulanmış adresler `ResearchService.reverifyContacts` ile yapay zekâsız teyit edilir.

## Öğrenen sistem

Kaynak: deneyim defteri (`LearningEvent`): her gönderim özellikleri ve sonucuyla, her adres araması, keşif, çalışan sayısı ve ilan araması sonucuyla kaydedilir. `LearnedModelsService.train()` her gece (ve yönetici ekranından elle) çalışır.

| Model | Soru | Örnekler | Özellikler | Kullanım |
|---|---|---|---|---|
| Teslim (ortak) | Adres mail alıyor mu | Ulaşan gönderimler olumlu; adresin kendisinden kaynaklanan geri dönüşler olumsuz (ek boyutu, dolu kutu, içerik reddi sayılmaz) | Adres türü, adresin başı, alan adı eşleşmesi, bulunduğu yer, doğrulanmışlık | Alıcı puanına eklenir (`recipientScore`): varsayılan alıcı, önizleme sırası, otopilotun sıradaki adresi |
| Yanıt (ortak) | Firma dönüş yapıyor mu | Ulaşmış gönderimler; yanıt olumlu, 21 gün yanıtsız kalan olumsuz | Fırsat türü, başvuru türü, adres türü, çalışan sayısı, firmanın geldiği yer | Fırsat sıralaması |
| İlgi (çalışma alanı başına) | Kullanıcı başvuruyor mu | Kendisinin başvurdukları olumlu, gizledikleri olumsuz | Fırsat türü, unvan eşleşmesi, konum, çalışan sayısı | Fırsat sıralaması |

- **Yöntem** (`domain/learning-model.ts`): kategorik özellikler tek tek göstergelere açılır; L2 düzenlileştirmeli lojistik regresyon Newton yöntemiyle ve adım küçültmeyle eğitilir (belirlenimci; aynı veri aynı modeli verir). Az görülen değer kendi ağırlığını almaz.
- **Etkinleşme.** Beş katlı çapraz doğrulamada log-kayıp temel orana göre en az %1 iyi, en az 120 örnek ve az görülen sonuçtan en az 20 örnek olmalıdır. Etkin olmayan model hiçbir kararı değiştirmez; sistem modelsiz davranışıyla aynen çalışır.
- **Alıcı puanı.** Kural tabanlı puana `(olasılık − temel oran) × 400` eklenir: aynı türdeki adresleri yeniden sıralar, İK adresini genel adresin gerisine ancak çok büyük fark düşürür. Ulaştığı görülmüş adreste kestirim yerine bilinen sonuç (0,98) kullanılır.
- **İstemlere giden deneyim** (`domain/learning-features.ts`): adres aramasına kaynak türüne göre ulaşma oranları (en az iki türde 15'er örnek ve 8 puan fark varsa), keşfe yanıt veren firmaların ortak sektör ve büyüklüğü (en az üç firma), yazıya adayın yanıt almış başvurularındaki firmaya özel paragraflar. İpucu eklenip eklenmediği sonuçla birlikte kaydedilir ve yönetici ekranında karşılaştırılır.
- **Dışa aktarım.** `GET /v1/admin/learning/export`: görev başına bir JSONL satırı (istem, kabul edilmiş çıktı, sonuç, kalite etiketi).

## Kod katmanları (backend)

| Katman | Sorumluluk |
|---|---|
| `src/domain` | Saf kurallar: unvan normalizasyonu, İstanbul ilçe/semt eşleme, Q/F/kapsam, ilan durum geçişleri, politika değerlendirmesi, gönderim durum makinesi, SSRF, CSV kaçışı, şablon kuralları, dosya taraması. Birim testli. |
| `src/engine` | Kaynak adaptörleri, ilan toplama/birleştirme, firma araştırması, fırsat değerlendirme, taslak üretimi, gönderim, otomasyon, yanıt işleme, bildirim, AI köprüsü. API ve worker ortak kullanır. |
| `src/modules` | REST uçları; tüm uçlar kimlik, workspace ve aday sahipliğini sunucuda doğrular. |
| `src/worker` | Outbox dağıtıcı, kuyruk işleyicileri, zamanlayıcı, Telegram long polling, kalp atışı. |

## Gönderim güvenliği (doküman §13)

1. `POST /v1/drafts/{id}/send` — `Idempotency-Key` zorunlu; aynı anahtar farklı içerikle gelirse **409**. Taslak sürümü ve ek hash'leri sabitlenir, `activeKey` (aday + kanonik ilan + amaç) benzersiz kısıtıyla tekrar engellenir. Yanıt **202 queued**.
2. Worker: satırı `SELECT … FOR UPDATE` ile kilitler; acil durdur, kampanya, politika sürümü, taslak hash'i, belge hash'i, hesap, kara liste, ilan durumu ve (otomatikte) 10 dakikalık tazelik yeniden kontrol edilir; günlük limit transaction içinde rezerve edilir; durum `sending` olur.
3. Acil durdur sağlayıcı çağrısından hemen önce yeniden okunur; tek dış çağrı yapılır.
4. Kabul → `provider_accepted` (teslim garantisi değil). Kesin ret → `failed_confirmed`. Bağlantı kopması/zaman aşımı → `submission_unknown`: **otomatik tekrar yok**, kullanıcı uzlaştırır. `sending`'de kalan kayıtlar uzlaştırma işinde belirsiz sayılır.

Eşzamanlı iki worker aynı işi alsa bile ikincisi kilit sonrası durumu `sending` gördüğü için dış çağrı yapmaz (e2e testi).

Gönderim modları: `manual` (kullanıcı), `campaign`, `auto` (politika; ilan tazeliği aranır) ve `autopilot` (geri dönen başvurunun kendiliğinden düzeltilmesi; doğrulanmış alıcı ve açık ilan aranır, acil durdurmaya uyar, "Otomatik başvur" kapatılırsa iptal olur).

## İlan durumu (doküman §4)

- Açık kapalı ibaresi ve geçmiş `validThrough` → kapalı.
- Tek kaybolma veya tek 404 kapanış değildir; eksiksiz taramada ardışık yokluk + detay kontrolü (404/kapalı) kapanış üretir.
- 403, 429, timeout ve eksik sayfalama kapanış kanıtı olamaz; kaynak `degraded/blocked` olur, otomatik ilan başvurusu durur.
- Resmî kaynak önceliklidir; ikincil kaynaktaki açık kopya kapalı resmî ilanı yeniden açamaz, çelişki kaydedilir.
- Yeniden açılma `openCycle` ile izlenir; geçmiş başvuru silinmez, yeniden gönderim yerine inceleme önerilir.

## Puanlama (doküman §5)

- **Q** (0–100): müşteri profili 35, kampanya/üretim 25, bağımsız itibar 15, hizmet uyumu 15, üretim yapısı 10. Her boyut 0/0.5/1; bilinmeyen boyut puana katkı vermez ve normalize edilmez. **Kapsam** kanıtlı boyut ağırlıklarının oranıdır. Global ağ müşterisi yerel müşteri sayılmaz; logo duvarı zayıf kanıttır. Kullanıcı boyut puanını elle belirleyebilir.
- **F** (rol uyumu): görev kapsamı 35, unvan 20, aday koşulları 20, coğrafya/çalışma biçimi 25. Zorunlu koşul bilinmiyorsa işaretlenir ve otomatik gönderim yapılmaz.

## AI köprüsü

Sohbet arayüzleri bot ile otomatikleştirilmez (sağlayıcı koşulları ve doküman §2). `AiService` sağlayıcıları çalışma alanı ayarındaki sırayla dener:

| Sağlayıcı | Nasıl | Kim |
|---|---|---|
| `cli_claude` | `claude -p --output-format json --tools ""` (firma raporu/keşifte yalnızca `WebSearch,WebFetch`); boş geçici dizinde çalışır | Yalnızca sunucu sahibinin çalışma alanı (kişisel abonelik) |
| `cli_codex` | `codex exec …` (argümanlar `CODEX_CLI_ARGS`) | Yalnızca sunucu sahibi |
| `manual` | Görev `awaiting_user` olur; kullanıcı istemi sohbete yapıştırır, cevabı geri yapıştırır | Herkes, kendi hesabıyla |
| `ollama`, `anthropic_api`, `openai_api` | İsteğe bağlı | Yapılandırılırsa |
| `template` | Kural tabanlı; olgu uydurmaz | Her zaman son çare |

Tüm çıktılar JSON şemasıyla doğrulanır: kaynaksız kanıt düşürülür, taslakta adayda olmayan yıl iddiası, yabancı e-posta adresi veya ilanı olmayan firmaya "ilanınıza" ifadesi reddedilir. Model alıcı, ek veya gönderim kararı veremez. Aynı girdi için başarılı sonuç önbellekten kullanılır; günlük görev bütçesi dolunca şablon moduna düşülür. Çıktısı reddedilen hafif model (haiku) sıradaki sağlayıcıya geçmeden önce bir kez üst modelle (sonnet) yeniden denenir.

### Öncelik sınıfları

Her görev bir sınıfta sayılır (`domain/ai-budget.ts`): `interactive` (kullanıcının beklediği iş) > `fix` (mail dönüşü) > `letters` > `research` > `discovery`. Sınıf görev türünden gelir; worker etkileşimli kuyruğu ve otopilotu `withAiClass` ile kendi sınıfında çalıştırır.

| Sınır | interactive | fix | letters | research | discovery |
|---|---|---|---|---|---|
| Günlük hakkın bu oranında durur | %100 | %95 | %75 | %65 | %50 |
| Tek başına kullanabileceği pay | %100 | %30 | %50 | %40 | %20 |
| Abonelik penceresi bu orana gelince sağlayıcıyı bırakır | %90 | %88 | %80 | %70 | %60 |

Abonelik kullanım pencereleri (5 saatlik, haftalık) Claude CLI'nin bildirdiği değerlerden okunur; kullanım bilgisi vermeyen sağlayıcı (Codex) yalnızca limit hatasıyla beklemeye alınır. Arka plan işleri (firma raporu, adres ve çalışan sayısı araması, keşif, ilan araması, arka plan yazıları) başlamadan önce sınıfın açık olup olmadığına bakılır; kapalıysa iş başlatılmaz ve sonraki turda yeniden planlanır. Hangi sağlayıcının kurulu olduğunu worker kalp atışıyla bildirir; API sınıfların durumunu buradan hesaplayıp ana ekrana verir.

## Güvenlik

- Tokenlar ve SMTP uygulama parolaları AES-256-GCM ile şifreli; yanıtlarda ve loglarda gösterilmez.
- Yükleme: uzantı + magic-byte, boyut sınırı, PDF etkin içerik ve Office makro kontrolü.
- SSRF: özel ağ, loopback, link-local/metadata adresleri bağlantı anında (DNS sonrası) engellenir; yönlendirmeler yeniden kontrol edilir; yanıt boyutu ve süre sınırlıdır.
- Webhook: HMAC-SHA256 imza + olay kimliğiyle tekrar koruması.
- CSV/XLSX dışa aktarımında formül kaçışı.
- Workspace sınırı sunucuda uygulanır; başka workspace'e ait kayıt 404 döner.

## Veri saklama (varsayılan)

Ham kaynak gözlemi 30 gün, geçici içe aktarma dosyası 24 saat, tarama/log kayıtları 90 gün, bildirimler 90 gün. Başvuru geçmişi kullanıcı silene kadar tutulur ve Excel/CSV olarak dışa aktarılabilir.
