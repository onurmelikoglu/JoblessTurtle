# Proje planı ve durum

Kaynak: *İş ve Firma Takip Asistanı — Geliştirme ve uygulama planı, Sürüm 1.1 (30 Eylül 2026)*.

## Git akışı

- `main`: yalnızca major sürümler (v1.0.0, v2.0.0 …). `dev → main` pull request ile.
- `dev`: tüm geliştirme. Ek modül veya uzun işler için ayrı branch açılmaz.

## Alınan kararlar

| Konu | Karar |
|---|---|
| Arayüz | **React + TypeScript** (`web/`), responsive web ve telefon tarayıcısı; telefon için PWA. 13 Ekim 2026'da Flutter web'den geçildi (kullanıcı kararı): uygulama web öncelikli ve liste/filtre ağırlıklı, backend zaten TypeScript. İlk sürümdeki Flutter arayüzü 14 Ekim 2026'da depodan kaldırıldı (kullanıcı kararı: artık kullanılmıyor). Mağaza uygulaması gerekirse aynı React kodu Capacitor ile sarılır. |
| Backend | NestJS (TypeScript), PostgreSQL + Prisma, Redis + BullMQ. API ve worker ayrı süreç, aynı imaj. |
| Dağıtım | Önce bilgisayarda Docker Compose + Cloudflare named tunnel; düzenli kullanımda VPS. |
| Kaynaklar | Greenhouse, Lever, firma kariyer sayfaları (JSON-LD/HTML, robots). LinkedIn/Indeed/Glassdoor/Kariyer.net için oturum açan ya da arama sayfası kazıyan bot yok; bu platformlardaki ilanlar AI web araması ve tekil ilan sayfasının izinli okunmasıyla gelecek (yol haritası Faz 3). |
| E-posta | Gmail OAuth (`gmail.send`) + SMTP (uygulama parolası) + test sağlayıcısı. |
| Bildirim | Uygulama içi + Telegram; mobil push sonraki aşama. |
| AI | **Çok modlu köprü** (kullanıcı kararı): Claude Code CLI / Codex CLI (sunucu sahibinin aboneliği, arka planda), manuel kopyala-yapıştır köprüsü (herkes kendi hesabıyla), Ollama / API isteğe bağlı, şablon son çare. Sohbet arayüzünü bot/n8n ile otomatikleştirme yok (sağlayıcı koşulları). |
| Firma listesi | Firmalar elle/Excel ile girilmez (kullanıcı kararı): arama profilindeki unvan, bölge ve sektörlere göre AI köprüsüyle **otomatik keşfedilir** — profil kaydedilince, profil unvanları değişince ve her gün. Önce açık rolü olan firmalar, sonra sektör uyumu; bulunan firmanın resmî kariyer/ATS sayfası kaynak olur. Excel içe aktarıcı yalnızca hazır listesi olanlar için isteğe bağlıdır. |

## Fazlar

| Faz | Kapsam | Durum |
|---|---|---|
| 1 Temel altyapı | Repo, Docker Compose, kullanıcı/aday ayrımı, veri modeli, belge sürümü, Excel import, responsive Flutter iskeleti | ✅ v1.0.0 |
| 2 Araştırma ve takip | ATS ve kariyer sayfası adaptörleri, unvan/bölge, gözlem/dedup, firma keşfi, kanıtlı rapor, Q/F puanı | ✅ v1.0.0 |
| 3 Manuel başvuru | OAuth mail, taslak/editör, tekil/toplu gönderim, tekrar engeli, Telegram | ✅ v1.0.0 |
| 4 Kurallı otomasyon | Politika sürümü, dry run, ilan/niyet/takip ayrımı, limitler, iptal, belirsiz gönderim | ✅ v1.0.0 |
| 5 Pilot ve işletim | Sabit HTTPS tünel, kullanıcı ayrımı, telefon tarayıcısı, kesinti ve yedek | ✅ araçlar hazır — pilot kullanıcıyla yürütülecek |

## P0 kabul ölçütleri (doküman §19) ve test karşılıkları

| Senaryo | Doğrulama |
|---|---|
| Başlangıç Excel | e2e: firma satırları kayıpsız, detaylar tekrar firma sayılmaz, anonim fırsat ayrı, geçmiş başvuru tekrar engeline girer |
| İlan farklı kaynaklarda | Kanonik ilan tek; listing ve gözlem ayrı; aynı aday için tek başvuru (activeKey) |
| 403 ve timeout | e2e + birim: kaynak blocked/degraded, ilan kapanmaz, otomatik başvuru durur |
| Resmî kapalı / kopya açık | e2e + birim: çelişki görünür, resmî kapanış kopya ile açılmaz |
| İlan bulunamadı | "Bu taramada hedef ilan bulunamadı" kategorisi; evrensel iddia yok |
| Global marka referansı | birim: yerel müşteri gibi puanlanmaz |
| Exact / adjacent | e2e: yakın rol opt-in kapalıysa otomatik gönderim yok |
| Lokasyon | birim: görev ofisi esas; belirsiz konum otomatik geçmez |
| Tahmin edilmiş adres | e2e + birim: gönderime dönüşmez |
| Aday değiştirme | e2e: başka adayın hesabı/belgesi kullanılamaz |
| Eşzamanlı iki worker | e2e: tek dış çağrı |
| Timeout sonrası kabul | e2e: submission_unknown, otomatik resend yok, uzlaştırma |
| Politika iptali | e2e: kuyruktaki iş sağlayıcı çağrısından önce iptal |
| Dosya/taslak değişimi | e2e: onaylı hash değişirse gönderim yok |
| Toplu kampanya | e2e: ayrı iletiler; hatalı satır diğerlerini değiştirmez |
| 202 ve SMTP kabulü | Arayüz ve bildirim metinleri kabulü teslim garantisi olarak sunmaz |
| Yanıt ve takip | e2e: insan yanıtı takibi iptal eder |
| Webhook tekrarı | e2e: tekilleştirme, imzasız istek reddi |
| Prompt injection / SSRF | birim + e2e: kaynak metni güvenilmeyen veri; private URL engelli; model alıcı seçemez |
| Arkadaş kullanıcıları | e2e: A, B'nin CV, taslak, hesap ve geçmişine erişemez |
| Telefon tarayıcısı | Playwright ile 390/768/1440 px ekran görüntüleri; widget testi |
| Backend kesintisi | Arayüzde çevrimdışı bandı; gönderim yapılmış gibi gösterilmez |
| Silme ve yedek | Aday silme belgeleri ve kuyruğu temizler; yedek/geri yükleme betikleri |
| Sunucu taşıma | docs/SETUP.md §9 prosedürü |

## Sonraki iş paketleri

Güncel sıra ve kapsam: **[ROADMAP.md](ROADMAP.md)** (v1.1: arayüz toparlama → ortak firma hafızası → ilan arama motoru → otopilot → öğrenen sistem). Aşağıdaki P1/P2 listesi v1.0 dönemindendir; yol haritasıyla çakışan maddelerde yol haritası geçerlidir.

**P1**
- Telefon için PWA bildirimi; mağaza uygulaması gerekirse Capacitor ile
- VPS'ye kalıcı geçiş ve izleme (uptime, kuyruk metrikleri paneli)
- Microsoft Graph (Outlook) OAuth sağlayıcısı
- Mailbox yanıt takibi: Gmail push/history ve Graph abonelikleri (`gmail.readonly` doğrulaması gerekir)
- Kullanıcının kendi ilan uyarısı e-postalarını içe alma
- Firma grubu birleştirme/ayırma arayüzü (gerekçeli, geri alınabilir)
- Harita görünümü

**P2**
- İzinli platform/ATS form adaptörleri (yazılı izin ve sözleşme sonrası)
- Ulaşım süresi hesabı (çıkış adresi + ulaşım modu)
- Takvim entegrasyonu
- Lisanslı firma/kişi veri servisleri (ayrı KVKK değerlendirmesiyle)
- Kullanıcı sayısının büyütülmesi, paylaşılan izinli kaynak önbelleği

## Operasyon öncesi kontrol listesi

- [ ] Kaynak koşulları ve robots politikaları kontrol edildi; izin notları kaynaklar ekranına girildi
- [ ] Gmail OAuth test kullanıcıları eklendi; yayın öncesi doğrulama planı
- [ ] `.env` gizli değerleri üretildi ve güvenli yerde yedeklendi
- [ ] Günlük yedek cron'u kuruldu, geri yükleme testi yapıldı
- [ ] KVKK: veri sorumlusu rolleri, yurt dışına aktarım (bulut/LLM/e-posta/bildirim sağlayıcıları) değerlendirildi
- [ ] Arkadaşlar için davet kodları oluşturuldu
