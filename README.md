# Jobless Turtle 🐢

Yavaş ama kararlı: iş aramanı senin yerine sürdüren, kendi sunucunda çalışan asistan.

## Ne yapar?

- **Firma ve ilan bulur.** Aradığın unvanlara ve şehirlere göre açık ilanı olan firmaları ve ilanı olmasa da uygun olan firmaları bulur. Kaynaklar: yapay zekâ ile web araması, firmaların kariyer sayfaları, açık arayüzlü başvuru sistemleri (Greenhouse, Lever, Workable, Ashby, SmartRecruiters, Personio, Teamtailor, Recruitee) ve uzaktan çalışma panoları.
- **Firmayı araştırır.** Resmî site, kariyer sayfası, ofisler, çalışan sayısı ve yayımlanmış İK adresi bulunur. Tahmin edilmiş adrese mail gönderilmez.
- **Başvuru yazısını hazırlar.** CV'ndeki doğrulanmış bilgilerden ve firmaya özel bir iki cümleden kişisel bir yazı oluşturur. Göndermeden önce düzenleyebilirsin.
- **Senin mailinden gönderir.** Tek tek, toplu ya da "Otomatik başvur" açıksa kendiliğinden. Gönderim varsayılan olarak hafta içi 09.00–18.00 arasında ve günlük sınırla yapılır.
- **Dönüşleri takip eder.** Gelen kutundaki geri dönen mailleri, otomatik yanıtları ve firma yanıtlarını okur, başvurunun durumunu günceller.
- **Otopilot ile düzeltir.** Adres geçersizse firmanın sıradaki doğrulanmış adresine gönderir, ek sığmadıysa yalnızca CV ile dener, emin olamadığını onayına bırakır.
- **İş alarmlarını okur.** Kariyer.net, LinkedIn, Indeed gibi sitelerin otomatik taramaya kapalı ilanlarını, bu sitelerde kurduğun iş alarmlarının maillerinden alıp listeye ekler.
- **İlan sitelerini tarar.** Kariyer.net ve Indeed'in oturumsuz görülebilen arama sayfalarını 4 saatte bir (ya da elle) tarar; site erişimi engellerse durur ve bildirir. Ayrıntılar ve sitelerin güncel erişim durumu: [docs/SCRAPERS.md](docs/SCRAPERS.md).
- **Açtığın ilan sayfasını aktarır.** Chrome eklentisi (`browser-extension/`) Kariyer.net ve Indeed'de kendi tarayıcında açtığın arama sonuç sayfasındaki ilanları okuyup aktarır; siteye kendi başına istek atmaz, doğrulama sayfasında durur. Kurulum: [browser-extension/README.md](browser-extension/README.md).
- **Deneyimden öğrenir.** Hangi adreslerin ulaştığını ve hangi başvurulara yanıt geldiğini kaydeder; yeterli veri birikince sıralamaları buna göre iyileştirir.
- **Birden çok kullanıcı.** Davet koduyla arkadaşlarını ekleyebilirsin; herkesin ayrı çalışma alanı, CV'si, mail hesabı ve geçmişi olur.

## Kurulum

Gerekenler: [Docker](https://docs.docker.com/get-docker/) (Docker Desktop ya da Docker Engine + Compose v2) ve bir mail hesabı.

```bash
git clone <bu-deponun-adresi> jobless-turtle
cd jobless-turtle
cp .env.example .env
```

`.env` dosyasında aşağıdaki dört değeri doldur (her biri için yeni rastgele değer üret):

```bash
openssl rand -base64 48   # JWT_SECRET
openssl rand -base64 32   # APP_ENCRYPTION_KEY (tam 32 bayt olmalı)
openssl rand -hex 24      # WEBHOOK_SECRET
openssl rand -hex 24      # POSTGRES_PASSWORD
```

> `APP_ENCRYPTION_KEY` bağlı mail hesaplarının parolalarını şifreler. Kaybolursa hesapları yeniden bağlaman gerekir; yedeğini güvenli bir yerde tut. `.env` dosyasını hiçbir zaman paylaşma ya da commit etme.

Başlat:

```bash
docker compose up -d --build
```

<http://localhost:8080> adresini aç ve hesap oluştur. **İlk kayıt olan kullanıcı sunucu yöneticisi olur**; sonraki kullanıcılar yöneticinin oluşturduğu davet koduyla kaydolur.

Önce denemek istersen `.env` içinde `SEED_DEMO=true` yap: `demo@ornek.local` / `demo12345` ile giriş yapılır, demo firmalar kurgusaldır ve gerçek siteye istek atılmaz.

Dışarıdan HTTPS ile erişim, mail sağlayıcıları, güncelleme, yedekleme ve sorun giderme için: [docs/SETUP.md](docs/SETUP.md).

## Kullanım

### 1. İlk kurulum (4 adım)

İlk girişte kısa bir sihirbaz açılır:

1. **Seni tanıyalım:** ad soyad, unvanın, iletişim mailin, varsa portföy bağlantın.
2. **CV ve portföy:** CV'ni (PDF ya da DOCX) yükle; portföy dosyası isteğe bağlı. Başvuru yazısı CV'ndeki bilgilerden hazırlanır.
3. **Aradığın pozisyonlar:** unvanlar (ör. "Sosyal Medya Uzmanı", "Mobile Developer"), şehirler ve uzaktan çalışmaya açık olup olmadığın. Yakın pozisyonlar ve yurt dışı tercihleri sonradan Profilim'den ayarlanır.
4. **Gönderim maili:** başvuruların gideceği hesabı bağla. En kolayı Gmail **uygulama şifresi**dir (Google hesabı › Güvenlik › 2 adımlı doğrulama › Uygulama şifreleri). Uygulama şifresiyle bağlanan hesaplarda gelen kutusu da okunabilir, böylece mail dönüşleri takip edilir. Outlook, Yandex ve kurumsal SMTP hesapları da çalışır.

Kurulum biter bitmez ilk arama başlar; ilk firmalar birkaç dakika içinde gelir. Sonrasında arama her gün kendiliğinden tekrarlanır.

### 2. Ana sayfa

Üstteki **durum paneli** o an ne yapıldığını (firma analizi, adres araması, yazı hazırlama), sıradaki işleri ve özet sayıları gösterir. Buradan:

- **Otomatik başvur** açıkken, yazısı hazır ve adresi doğrulanmış firmalara başvuru gönderim saatlerinde kendiliğinden gider. Kapalıyken yazılar hazırlanır ve senin onayını bekler.
- **Yeniden ara** aramayı hemen başlatır; **Durdur** sıradaki arama işlerini iptal eder (gönderim ve mail takibi sürer).

Altında üç sekme vardır:

| Sekme | Ne işe yarar |
|---|---|
| **Firmalar** | Başvurmadığın firmalar; önce açık ilanı olanlar. Arama kutusu ve filtreler (açık ilan, bölgede ofisi var, mail adresi var/yok, yazısı hazır, kapsam, çalışan sayısı). Her firmada ilan, bulunan adres, firma analizi ve **Başvur** butonu bulunur. Önizlemede yazıyı ve alıcıyı düzenleyip gönderebilir, birden çok firmayı seçip toplu başvurabilirsin. Listede olmayan bir firmayı adını yazıp ekletebilir ya da yazdığın metinle ilan taratabilirsin. |
| **Başvurularım** | Gönderilen, sırada bekleyen ve geri dönen başvurular; her birinin ayrıntısı, gönderilen yazı ve ekler. Sıradaki başvuruyu iptal edebilir, geri döneni düzeltip yeniden gönderebilirsin. |
| **Mail dönüşleri** | Gelen kutundan okunan dönüşler: iletilemedi, adres değişti, "kariyer sitemizden başvurun", otomatik yanıt, firma yanıtı. **Otopilot** paneli bu dönüşler için ne yaptığını ve onayını bekleyen önerileri gösterir. **İş alarmları** paneli alarm kurulumunu ve alarm maillerinden eklenen ilanları gösterir. |

### 3. İş alarmları (Kariyer.net, LinkedIn, Indeed)

Bu siteler ilanlarının otomatik taranmasına izin vermez; uygulama da bu korumaları aşmaya çalışmaz. Bunun yerine sitenin kendi bildirimini kullanır:

1. **Mail dönüşleri › İş alarmları** panelinde her site için profilindeki unvanlardan hazır aramalar listelenir.
2. Bir aramaya bas; site o aramayla açılır. Kendi hesabınla giriş yapıp sitedeki **iş alarmı / uyarı oluştur** düğmesine bas, sıklığı "günlük" seç.
3. Alarm mailleri uygulamaya bağlı adrese gelmeli (sitedeki hesabın başka adresle açıksa o adresten yönlendirme kur).
4. Mail geldiğinde ilanlar okunur, profiline uyanlar Firmalar listesine eklenir ve sitenin yanında "Alarm çalışıyor" yazar. Mail saklanmaz.

### 4. Bildirimler

Yeni ilanlar, gönderim sonuçları, firma yanıtları ve otopilot kararları **Bildirimler** sayfasına düşer. Bildirime tıklamak seni ilgili kayda götürür: yeni ilan bildirimi o ilanları, gönderim bildirimi başvurunun ayrıntısını, mail dönüşü bildirimi o maili açar. Uygulama sana mail göndermez; mailine yalnızca başvuruların ve firmaların yanıtları gelir.

### 5. Profilim

Bilgilerin, CV ve portföy sürümlerin, aradığın pozisyonlar, gönderim maili ve günlük gönderim sınırı, başvuru yazısı kalıpları (istersen kendi örnek yazın), yapay zekâ kullanımı ve hesap ayarları buradadır. Yönetici ayrıca davet kodlarını, kullanıcıları ve öğrenme ekranını görür.

## Yapay zekâ

Firma bulma, araştırma, yazı hazırlama ve mail dönüşlerini okuma işleri bir yapay zekâ modeliyle yapılır. Seçenekler (birini kurman yeterli):

| Seçenek | Not |
|---|---|
| **Claude Code CLI** | Kendi Claude aboneliğinle arka planda çalışır. Docker'da: `.env` içinde `INSTALL_AI_CLI=true`, ardından `docker compose up -d --build worker` ve bir kez `docker compose exec -it worker claude` ile giriş. |
| **Codex CLI** | ChatGPT hesabınla; kurulumu benzer (`codex login`). |
| **Manuel köprü** | Uygulama istemi hazırlar, sen Claude ya da ChatGPT sohbetine yapıştırıp cevabı geri yapıştırırsın. Herkes kendi hesabıyla kullanabilir. |
| **Ollama / API anahtarı** | İsteğe bağlı yerel model ya da Anthropic / OpenAI API anahtarı. |
| **Hiçbiri** | Şablon modu: yazılar hazır kalıplardan oluşur, araştırma yapılmaz. |

CLI sağlayıcıları kişisel abonelik kullandığı için varsayılan olarak yalnızca sunucu sahibinin çalışma alanında açılır; yönetici isterse davetlilere de günlük limitle açabilir. Günlük görev hakkı ve abonelik kullanım oranı daraldıkça önce düşük öncelikli işler (keşif, araştırma) durur; senin başlattığın işler ve mail dönüşleri en son durur. Ayrıntılar: [docs/SETUP.md › Yapay zekâ](docs/SETUP.md#4-yapay-zekâ).

## İlkeler

- **Atlatma yok.** Sitelere oturum açılmaz; korumalar (CAPTCHA, 403, bot doğrulaması) aşılmaz, tarayıcı kimliği taklit edilmez, vekil sunucu kullanılmaz. Kariyer.net ve Indeed'in yalnızca herkese açık arama sayfaları, robots.txt'e uyularak ve kendini tanıtan bir istemciyle taranır; erişim engellenen kaynak duraklatılır. Sohbet arayüzleri (claude.ai, chatgpt.com) otomatikleştirilmez.
- **Yalnızca kendi mailinden, yalnızca doğrulanmış adreslere.** Tahmin edilmiş adrese gönderilmez; geri dönen adres kalıcı olarak kapatılır. Model alıcı, ek ya da yetki seçemez.
- **"Gönderildi", mail sağlayıcısının kabulüdür**; teslim ya da okunma garantisi değildir. Sonucu belirsiz gönderim otomatik tekrarlanmaz.
- **Gizlilik.** Gelen kutusunda yalnızca gönderdiğin başvurulara dönen mailler ve iş sitelerinin ilan bildirimleri okunur; diğer mailler okunmaz ve saklanmaz. Mail parolaları şifreli tutulur. Veriler senin sunucunda kalır.

## Geliştirme

PostgreSQL 16, Redis 7 ve Node.js 22 ile Docker olmadan da çalışır: `cp .env.example .env` (veritabanı adreslerini localhost'a göre ayarla) ve `./scripts/dev.sh`. Bu modda worker bilgisayarında çalıştığı için `claude` / `codex` girişin doğrudan kullanılır.

```bash
# Backend (NestJS + Prisma + BullMQ)
cd backend && npm ci
npm run lint && npm run typecheck
npm test                 # birim testleri
npm run test:e2e         # gerçek PostgreSQL + Redis ile uçtan uca testler (TEST_DATABASE_URL, TEST_REDIS_URL)
npm run dev:api          # API, :3000
npm run dev:worker       # arka plan işleri

# Web arayüzü (React + TypeScript + Tailwind)
cd web && npm ci
npm run lint && npm run typecheck && npm test
VITE_API_PROXY=http://localhost:3000 npm run dev   # http://localhost:5173
```

API dokümantasyonu çalışan sunucuda `/api/docs` adresindedir.

```
backend/   API ve worker (aynı imaj)
  src/domain/     saf iş kuralları (unvan, bölge, puanlama, ilan durumu, otopilot, öğrenme)
  src/engine/     kaynaklar, ilan arama, araştırma, yazı, gönderim, gelen kutusu, yapay zekâ köprüsü
  src/modules/    REST uçları
  src/contracts/  arayüzle paylaşılan yanıt tipleri
  prisma/         veri modeli ve geçişler
web/       React arayüzü
browser-extension/  Kariyer.net / Indeed sayfalarını aktaran Chrome eklentisi (MV3, derlemesiz)
docs/      mimari, kurulum, yol haritası
scripts/   yerel çalıştırma, yedekleme, geri yükleme
```

Ayrıntılar: [Mimari](docs/ARCHITECTURE.md) · [Kurulum](docs/SETUP.md) · [Yol haritası](docs/ROADMAP.md) · [Değişiklikler](CHANGELOG.md)

## Lisans

[MIT](LICENSE)
