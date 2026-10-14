# Kurulum rehberi

Kısa tanıtım ve kullanım için: [README](../README.md).

## 1. Docker Compose ile kurulum

1. [Docker Desktop](https://docs.docker.com/get-docker/) (ya da Docker Engine + Compose v2) kur.
2. Depoyu klonla ve ortam dosyasını hazırla:

   ```bash
   cp .env.example .env
   openssl rand -base64 32   # → APP_ENCRYPTION_KEY
   openssl rand -base64 48   # → JWT_SECRET
   openssl rand -hex 24      # → WEBHOOK_SECRET
   openssl rand -hex 24      # → POSTGRES_PASSWORD
   ```

   **`APP_ENCRYPTION_KEY` kaybolursa bağlı mail hesapları yeniden bağlanmalıdır**; yedeğini güvenli bir yerde tut. `.env` dosyasını paylaşma ve commit etme.

3. Başlat:

   ```bash
   docker compose up -d --build
   ```

   Web imajı React arayüzünü (`web/`) imajın içinde derler; bilgisayarda Node.js gerekmez.

   Daha hızlı yol (Node.js 22 gerekir; arayüz bilgisayarda derlenir, imaj yalnızca paketler):

   ```bash
   (cd web && npm ci && npm run build)
   WEB_DOCKERFILE=Dockerfile.prebuilt docker compose up -d --build --no-deps web
   ```

4. <http://localhost:8080> adresini aç ve hesap oluştur. **İlk kayıt olan kullanıcı sunucu yöneticisidir.** Diğer kullanıcılar için **Profilim › Yönetici › Arkadaş daveti** bölümünden davet kodu üret; kayıt ekranında bu kod istenir (`.env` içinde `REGISTRATION_MODE=open` yaparsan kod istenmez).

Uygulama senin bilgisayarında çalışıyorsa bilgisayar açık, internete bağlı ve uyku moduna geçmeyecek şekilde ayarlı olmalıdır. Servisler `restart: unless-stopped` ve sağlık kontrolü taşır. Kesintiden sonra worker kuyrukları yeniden kontrol eder; sonucu belirsiz gönderim otomatik tekrarlanmaz.

### Güncelleme

```bash
git pull
docker compose build api web
docker compose run --rm --no-deps api migrate
docker compose up -d --no-deps api worker web
```

Önce yedek al (bölüm 7). `--no-deps` veritabanı ve Redis konteynerlerinin gereksiz yere yeniden oluşturulmasını önler. Derlemeden sonra `docker builder prune` ile derleme önbelleğini temizleyebilirsin.

## 2. Dışarıdan erişim (HTTPS)

Telefondan ya da başka bir bilgisayardan erişmek ve arkadaşlarını davet etmek için sabit bir HTTPS adresi gerekir. Her iki yolda da yalnızca web servisi dışarı açılır; veritabanı ve Redis açılmaz, uygulama girişi ayrıca gerekir.

### 2a. Ücretsiz, alan adı gerektirmeyen yol: Tailscale Funnel

Sabit bir adres verir (`https://<bilgisayar>.<tailnet>.ts.net`); karşı tarafın bir şey kurması gerekmez.

1. Uygulamanın çalıştığı bilgisayara [Tailscale](https://tailscale.com/download) kur ve ücretsiz hesapla giriş yap.
2. Uygulama `http://localhost:8080` adresinde çalışırken:

   ```bash
   tailscale funnel --bg 8080
   ```

   İlk seferde komut, Tailscale yönetim panelinde HTTPS ve Funnel'ı etkinleştirmek için bir bağlantı verir; onaylayıp komutu tekrar çalıştır. `tailscale funnel status` herkese açık adresi gösterir.
3. `.env` içinde `APP_PUBLIC_URL=https://<bilgisayar>.<tailnet>.ts.net` yap ve `docker compose up -d` ile yeniden başlat.

### 2b. Kendi alan adınla: Cloudflare Tunnel

1. Cloudflare hesabına bir alan adı ekle.
2. **Zero Trust › Networks › Tunnels › Create a tunnel** (Cloudflared) ile bir tünel oluştur, token'ı kopyala.
3. Tünele bir public hostname ekle: ör. `is.alanadin.com` → servis `http://web:80`.
4. `.env` içinde:

   ```
   APP_PUBLIC_URL=https://is.alanadin.com
   CLOUDFLARE_TUNNEL_TOKEN=<token>
   ```

5. `docker compose --profile tunnel up -d`

Kısa bir deneme için geçici Quick Tunnel (`cloudflared tunnel --url http://localhost:8080`) da olur, ama adres her seferinde değiştiği için bildirim bağlantıları bozulur.

## 3. Gönderim maili

Başvurular kullanıcının **kendi mail hesabından** gider. Hesap ilk kurulum sihirbazında ya da sonradan **Profilim › Gönderim maili** bölümünden bağlanır. Normal şifre girilmez; sağlayıcının **uygulama şifresi** kullanılır. Şifre AES-256-GCM ile şifreli saklanır ve sağlayıcının hesap ayarlarından istenildiği an iptal edilebilir.

| Sağlayıcı | Uygulama şifresi | Not |
|---|---|---|
| Gmail | <https://myaccount.google.com/apppasswords> | Google hesabında 2 adımlı doğrulama açık olmalı. |
| Outlook / Hotmail | <https://account.live.com/proofs/AppPassword> | Microsoft hesabında 2 adımlı doğrulama açık olmalı. |
| Yandex | <https://id.yandex.com/security/app-passwords> | |
| Diğer (kurumsal, Zoho, Yahoo…) | Sağlayıcının ayarları | SMTP sunucusu ve portunu (465 TLS ya da 587 STARTTLS) elle gir. |

Bilinen sağlayıcılarda sunucu ayarları kendiliğinden gelir. Aynı bölümden **günlük gönderim limiti** ayarlanır; fazlası ertesi gün gider ve mailler arasında 30–50 saniye beklenir.

### Gelen kutusu takibi

Gmail, Outlook, Yahoo, Yandex ve Zoho hesaplarında aynı uygulama şifresiyle gelen kutusu da okunur (IMAP). Uygulama 10 dakikada bir:

- gönderilen başvurulara dönen hata bildirimlerini, otomatik yanıtları ve firma yanıtlarını,
- iş sitelerinin ilan bildirimlerini (iş alarmları)

okur; başka hiçbir maili okumaz ve saklamaz. Takip **Ana sayfa › Mail dönüşleri** sekmesinden açılıp kapatılır. Gmail'de IMAP varsayılan olarak açıktır; kapalıysa Gmail ayarlarından açılmalıdır.

### İş alarmları

Kariyer.net, LinkedIn ve Indeed ilanlarının otomatik taranmasına izin vermez. Bu sitelerde kullanıcının kendi hesabıyla kurduğu iş alarmlarının mailleri okunur ve profile uyan ilanlar listeye eklenir. Kurulum: **Mail dönüşleri › İş alarmları** panelindeki hazır aramalardan birine bas, açılan sitede alarmı kur (sıklık: günlük). Alarm mailleri uygulamaya bağlı adrese gelmelidir. İlk mail geldiğinde site "Alarm çalışıyor" olarak işaretlenir.

## 4. Yapay zekâ

Firma ve ilan bulma, firma araştırması, yazı hazırlama ve mail dönüşlerini okuma bir yapay zekâ modeliyle yapılır. Sohbet arayüzleri (claude.ai, chatgpt.com) bot ile otomatikleştirilmez; resmî komut satırı araçları ya da kopyala-yapıştır köprüsü kullanılır.

Durum ve ayarlar **Profilim › AI kullanımı ve modeller** bölümündedir: sağlayıcıların durumu, görev türüne göre model seçimi, günlük işlem limiti ve kullanım geçmişi. Sağlayıcı sırası Claude → ChatGPT → kopyala-yapıştır'dır; Claude limit hatası verirse ChatGPT'ye geçilir.

### a) Claude Code CLI (kendi Claude aboneliğinle, arka planda)

- **Docker ile:** `.env` içinde `INSTALL_AI_CLI=true` → `docker compose up -d --build worker` → bir kez giriş yap:

  ```bash
  docker compose exec -it worker claude    # tarayıcıdaki giriş adımlarını izle, sonra /exit
  ```

  Giriş bilgileri `ai-cli-home` volume'ünde kalır; repoya ya da imaja girmez.
- **Docker olmadan:** `npm i -g @anthropic-ai/claude-code`, `claude` komutuyla bir kez giriş yap, uygulamayı `./scripts/dev.sh` ile çalıştır.

Araştırma ve keşifte CLI'ya yalnızca web araması ve sayfa okuma araçları açılır; komut çalıştırma ve dosya düzenleme kapalıdır, CLI boş bir geçici dizinde çalışır.

Abonelik kişisel olduğu için CLI sağlayıcıları varsayılan olarak yalnızca sunucu sahibinin çalışma alanında kullanılır. Yönetici **Davetliler benim Claude aboneliğimi kullanabilir** seçeneğini açarsa davetliler de kullanır; davetli başına günlük limit ayrıca ayarlanır.

### b) Codex CLI (ChatGPT hesabınla)

`INSTALL_AI_CLI=true` ile kurulur; bir kez giriş:

```bash
docker compose exec -it worker codex login --device-auth
```

Argümanlar sürüme göre değişebilir; gerekirse `CODEX_CLI_ARGS` ile ayarla (varsayılan `exec --skip-git-repo-check -`).

### c) Kopyala-yapıştır köprüsü

CLI yoksa görev "seni bekliyor" olarak düşer ve ana sayfada bildirilir: **istemi kopyala → Claude ya da ChatGPT sohbetine yapıştır → cevabı geri yapıştır**. Cevap şemayla ve kaynak kurallarıyla doğrulanır; kurallara aykırıysa gerekçesiyle reddedilir. Herkes kendi hesabıyla kullanabilir.

### d) İsteğe bağlı

Yerel model: `OLLAMA_URL=http://host.docker.internal:11434`. API anahtarları: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`. Hiçbir sağlayıcı yoksa şablon modu çalışır: yazılar hazır kalıplardan oluşur, araştırma yapılmaz, bilgi uydurulmaz.

### Günlük kullanım ve öncelikler

Yapay zekâ işleri beş öncelik sınıfında sayılır: kullanıcının başlattığı işler, mail dönüşleri ve iş alarmları, yazı hazırlama, araştırma, keşif. Günlük işlem hakkı ya da aboneliğin kullanım oranı daraldıkça önce keşif ve araştırma durur; kullanıcının beklediği işler en son durur. Bekletilen işler hak açılınca kendiliğinden devam eder.

## 5. Firma ve ilan araması

Firmalar elle girilmez. Arama profilindeki unvanlar, yakın pozisyonlar, şehirler ve uzaktan/yurt dışı tercihlerine göre:

- yapay zekâ ile web'de unvan × şehir ilan araması yapılır,
- bulunan firmaların resmî sitesi, kariyer sayfası ve başvuru sistemi (Greenhouse, Lever, Workable, Ashby, SmartRecruiters, Personio, Teamtailor, Recruitee) bulunur ve bu sayfalar düzenli takip edilir,
- ilanı olmasa da hedef sektördeki uygun firmalar önerilir.

Arama kurulumdan hemen sonra başlar ve her gece kendiliğinden tekrarlanır. Ana sayfadaki **Yeniden ara** aramayı hemen başlatır, **Durdur** sıradaki arama işlerini iptal eder. Profilde unvan, şehir ya da tercih değişince arama yenilenir. Firmalar ekranında listede olmayan bir firmayı adıyla ekletebilir ya da yazdığın metinle ilan taratabilirsin.

Erişimi engelleyen (403, CAPTCHA) bir kaynak duraklatılır; engel aşılmaz.

## 6. Otomatik başvuru ve otopilot

- **Otomatik başvur** (ana sayfa durum paneli) açıkken, yazısı hazır ve adresi doğrulanmış firmalara başvuru varsayılan olarak hafta içi 09.00–18.00 arasında, günlük limitle kendiliğinden gönderilir. Kapalıyken yazılar hazırlanır ve onayını bekler.
- **Otopilot** geri dönen başvuruları düzeltir: adres geçersizse firmanın sıradaki doğrulanmış adresine gönderir, adres yoksa bir kez yeni adres arar, ek sığmadıysa yalnızca CV ile dener. Otomatik başvuru kapalıyken düzeltmeler **Mail dönüşleri › Otopilot** panelinde onay bekler. Bir başvuru için en fazla iki otomatik düzeltme yapılır.

## 7. Yedekleme ve geri yükleme

```bash
./scripts/backup.sh                      # backups/ altına veritabanı dökümü + belgeler (14 gün saklanır)
./scripts/restore.sh backups/db-….dump backups/documents-….tar.gz
```

Günlük yedek için cron: `0 3 * * * cd /yol/jobless-turtle && ./scripts/backup.sh`. `.env` dosyasını (özellikle `APP_ENCRYPTION_KEY`) ayrıca yedekle. `backups/` klasörü kişisel veri içerir ve git'e girmez.

## 8. Başka bir sunucuya taşıma

1. Yeni sunucuya Docker kur, depoyu ve `.env` dosyasını taşı.
2. Eski makinede: `docker compose stop worker` (iki sunucu aynı başvuruyu paralel göndermemeli), sonra `./scripts/backup.sh`.
3. Yeni sunucuda: `docker compose up -d postgres redis`, `./scripts/restore.sh …`, ardından `docker compose up -d`.
4. **Başvurularım** sekmesinde sonucu belirsiz görünen gönderimleri kontrol et.
5. Tünel token'ını yeni sunucuda kullan; adres aynı kaldığı için bağlantılar değişmez.
6. Eski makinede `docker compose down`.

## 9. Sorun giderme

| Belirti | Çözüm |
|---|---|
| Arayüzde "Sunucuya ulaşılamıyor" | `docker compose ps`, `docker compose logs api` |
| Durum panelinde "Arka plan servisi yanıt vermiyor" | `docker compose logs worker`; Redis sağlıklı mı? |
| Gönderim maili "yeniden bağlanmalı" | Uygulama şifresi iptal edilmiş ya da değişmiş olabilir; Profilim › Gönderim maili'nden yeni şifreyle yeniden bağla. |
| Mail dönüşleri gelmiyor | Hesabın uygulama şifresiyle bağlı ve sağlayıcısında IMAP açık mı? Mail dönüşleri sekmesindeki hata mesajına bak. |
| AI görevleri hep "seni bekliyor" | Profilim › AI kullanımı ve modeller'de sağlayıcı durumuna bak; CLI girişini yenile (`docker compose exec -it worker claude`) ya da kopyala-yapıştır köprüsünü kullan. |
| Arama ilerlemiyor, "hak doldu" | Günlük AI işlem limitine ya da abonelik kullanım sınırına ulaşılmış; işler hak açılınca kendiliğinden devam eder. |
| Disk doldu | `docker system df`; `docker builder prune` derleme önbelleğini temizler. |

## Arayüzü olmayan sunucu özellikleri

Sunucu tarafında bulunan ama güncel arayüzde ekranı olmayan özellikler (API üzerinden kullanılabilir, `/api/docs`):

- **Gmail OAuth** (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`; yalnızca `gmail.send` kapsamı). Uygulama şifresi yolu daha basittir ve gelen kutusu takibini de sağlar.
- **Telegram bildirimleri** (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`).
- **Excel içe/dışa aktarma** (hazır firma listesinin sütun eşlemeli içe aktarılması).
