# Jobless Turtle — tarayıcı eklentisi

Kariyer.net, Indeed, Eleman.net, İşin Olsun, Secretcv ve Yenibiriş'te **kendi tarayıcında açtığın** arama sonuç sayfasındaki
ilanları Jobless Turtle'a aktarır.
Chrome (Manifest V3) eklentisidir; derleme adımı yoktur.

## Ne yapar, ne yapmaz

- Yalnızca açık sayfayı okur (`www.kariyer.net/is-ilanlari/*`, `tr.indeed.com/jobs*`, `www.eleman.net/is-ilanlari*`,
  `isinolsun.com/is-ilanlari*`, `www.secretcv.com/is-ilanlari*`, `www.yenibiris.com/is-ilanlari*`). Siteye kendi başına
  istek atmaz, gezinmez, tıklamaz, sayfaya yazmaz; sayfa geçişini sen yaparsın.
- Sayfada güvenlik doğrulaması (CAPTCHA) varsa aktarım yapılmaz: "Sayfada doğrulama var; tamamlayınca tekrar dene."
  Doğrulama aşılmaya çalışılmaz.
- Okunan veri yalnızca seçeneklerde girdiğin uygulama adresine, yalnızca o adres için verdiğin izinle gönderilir.

## Kurulum

1. Uygulamada **Kurulum** ya da **Profilim › Tarayıcı eklentisi** bölümündeki **Eklentiyi indir** ile zip dosyasını indir ve bir klasöre aç (depoyu
   klonladıysan bu klasörü, `browser-extension`, doğrudan kullanabilirsin).
2. Chrome'da `chrome://extensions` adresini aç, sağ üstten **Geliştirici modu**nu aç.
3. **Paketlenmemiş öğe yükle** → zipten çıkan klasörü seç. Eklentinin ayarları kendiliğinden açılır.
4. Uygulamada **Kurulum › Tarayıcı eklentisi › Eşleştirme kodunu kopyala** (ya da Profilim › Tarayıcı eklentisi ›
   **Eşleştirme kodu üret** ve **Kopyala**); kodu eklenti ayarlarındaki **Eşleştirme kodu** alanına yapıştır
   (adres ve anahtar kendiliğinden dolar), **Kaydet ve dene**. Chrome uygulama adresine erişim izni ister; izin vermezsen
   aktarım yapılamaz. "Bağlandı: <adın>" görmelisin. Kod yalnızca bir kez gösterilir.

Ayarları sonradan açmak için eklentinin simgesine tıkla. Adres ve anahtarı elle de girebilirsin.

## Kullanım

- Desteklenen bir sitenin arama sonuç sayfasında sağ alttaki **Jobless Turtle'a aktar** düğmesine bas. Bildirimde kaç
  ilanın aktarıldığı ve kaçının arama profiline uyup eklendiği yazar ("52 ilan aktarıldı, 3'ü profile uyuyor").
- Uygulamanın Firmalar sekmesindeki **Kariyer.net'te ara**, **Indeed'de ara**, **Eleman.net'te ara**… bağlantıları adresin sonuna `#jt-import=<etiket>`
  ekler. O sekmede gezdiğin her sonuç sayfası bir kez kendiliğinden aktarılır; bildirimdeki **Kapat** ile bu sekmede
  kapatılır.
- **Hepsini aç (N sekme):** Firmalar'daki bu düğme profildeki bütün pozisyon × şehir aramalarını (bütün siteler sırayla, en çok 20)
  ayrı sekmelerde açar; her sekmedeki sonuçlar kendiliğinden aktarılır. Tarayıcı tek tıkla birden çok sekme açılmasını
  engellediği için sekmeleri eklenti açar: uygulama sayfasındaki köprü (`app-bridge.js`, yalnızca kayıtlı uygulama
  adresinde çalışır) adres listesini arka plana iletir, arka plan yalnızca desteklenen sitelerin arama sonuç sayfalarını
  (`#jt-import` ekli) açar. Eklenti yoksa yalnızca ilk arama açılır.
- **Hangi hesaba gider?** Uygulamadan açılan aramanın ekindeki etiket (şifreli) aramayı başlatan hesabı taşır; o
  sekmedeki aktarımlar o hesabın profillerine gider. Sitede kendin açtığın, etiketsiz sayfa anahtar sahibinin hesabına
  gider.
- Aynı sayfayı yeniden aktarmak kopya oluşturmaz; ilanlar tekilleştirilir. Aynı sayfa 2 dakika içinde yeniden
  gönderilirse yeni çalışma da açılmaz.

## Dosyalar

| Dosya | Görevi |
|---|---|
| `manifest.json` | İzinler: `storage`, `scripting` (köprüyü yalnızca uygulama adresine kaydetmek için); uygulama adresi için isteğe bağlı host izni; içerik betiği yalnızca desteklenen sitelerin arama sayfalarında |
| `app-bridge.js` | Uygulama sayfasında: eklentinin kurulu olduğunu işaretler (`data-jt-extension`), "Hepsini aç" isteğini arka plana iletir |
| `extractors.js` | Sayfayı okuyan betikler. **Üretilir, elle düzenlenmez:** `cd backend && npm run extension:extractors` (kaynak: `backend/src/engine/scrapers/parsers/*.browser.ts`) |
| `content.js` | Düğme, bildirim, otomatik aktarım (sekme başına `sessionStorage`) |
| `background.js` | Gönderim: `POST <uygulama>/api/v1/scrapers/import`, başlık `X-Import-Token`; köprü kaydı; "Hepsini aç" sekmeleri (adres denetimiyle) |
| `options.html`, `options.js` | Eşleştirme kodu (`jt1.` + base64url JSON `{u: adres, k: anahtar}`), uygulama adresi ve anahtar; kaydederken erişim izni, `GET /api/v1/scrapers/import/check` ile bağlantı denemesi |

Sitenin sayfa düzeni değişirse önce `backend/src/engine/scrapers/selectors/` güncellenir, sonra `extractors.js` yeniden
üretilir ve eklenti `chrome://extensions` sayfasında yenilenir. Ayrıntı: [docs/SCRAPERS.md](../docs/SCRAPERS.md#tarayıcı-eklentisi-kullanıcının-açtığı-sayfa).

## Güncelleme

Eklenti güncellendiğinde (`manifest.json` sürümü değişir; şu an 1.4.0) `chrome://extensions` sayfasında Jobless Turtle
kartındaki yenile düğmesine bas; açık site sekmelerini de yenile. Yenibiriş sunucudan taranamadığı için (Cloudflare)
ilanları yalnızca bu eklentiyle gelir.

## Chrome Web Mağazası

Mağaza metni, izin gerekçeleri ve paketleme adımları: [CHROME-WEB-STORE.md](CHROME-WEB-STORE.md).
