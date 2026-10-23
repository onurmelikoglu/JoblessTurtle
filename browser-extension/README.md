# Jobless Turtle — tarayıcı eklentisi

Kariyer.net ve Indeed'de **kendi tarayıcında açtığın** arama sonuç sayfasındaki ilanları Jobless Turtle'a aktarır.
Chrome (Manifest V3) eklentisidir; derleme adımı yoktur.

## Ne yapar, ne yapmaz

- Yalnızca açık sayfayı okur (`https://www.kariyer.net/is-ilanlari/*`, `https://tr.indeed.com/jobs*`). Siteye kendi başına
  istek atmaz, gezinmez, tıklamaz, sayfaya yazmaz; sayfa geçişini sen yaparsın.
- Sayfada güvenlik doğrulaması (CAPTCHA) varsa aktarım yapılmaz: "Sayfada doğrulama var; tamamlayınca tekrar dene."
  Doğrulama aşılmaya çalışılmaz.
- Okunan veri yalnızca seçeneklerde girdiğin uygulama adresine, yalnızca o adres için verdiğin izinle gönderilir.

## Kurulum

1. Chrome'da `chrome://extensions` adresini aç.
2. Sağ üstten **Geliştirici modu**nu aç.
3. **Paketlenmemiş öğe yükle** → bu klasörü (`browser-extension`) seç.
4. Uygulamada **Profilim › Tarayıcı eklentisi › Anahtar üret**; anahtar yalnızca bir kez gösterilir, kopyala.
5. Eklentinin simgesine tıkla (ya da eklenti ayrıntılarında **Uzantı seçenekleri**): uygulama adresini (ör.
   `http://localhost:8080`) ve anahtarı gir, **Kaydet ve dene**. Chrome bu adrese erişim izni ister; izin vermezsen
   aktarım yapılamaz. "Bağlandı: <adın>" görmelisin.

## Kullanım

- Kariyer.net ya da Indeed arama sonuç sayfasında sağ alttaki **Jobless Turtle'a aktar** düğmesine bas. Bildirimde kaç
  ilanın aktarıldığı ve kaçının arama profiline uyup eklendiği yazar ("52 ilan aktarıldı, 3'ü profiline uyuyor").
- Uygulamanın Firmalar sekmesindeki **Kariyer.net'te ara** / **Indeed'de ara** bağlantıları adresin sonuna `#jt-import`
  ekler. O sekmede gezdiğin her sonuç sayfası bir kez kendiliğinden aktarılır; bildirimdeki **Kapat** ile bu sekmede
  kapatılır.
- Aynı sayfayı yeniden aktarmak kopya oluşturmaz; ilanlar tekilleştirilir.

## Dosyalar

| Dosya | Görevi |
|---|---|
| `manifest.json` | İzinler: `storage`; uygulama adresi için isteğe bağlı host izni; içerik betiği yalnızca iki sitenin arama sayfalarında |
| `extractors.js` | Sayfayı okuyan betikler. **Üretilir, elle düzenlenmez:** `cd backend && npm run extension:extractors` (kaynak: `backend/src/engine/scrapers/parsers/*.browser.ts`) |
| `content.js` | Düğme, bildirim, otomatik aktarım (sekme başına `sessionStorage`) |
| `background.js` | Gönderim: `POST <uygulama>/api/v1/scrapers/import`, başlık `X-Import-Token` |
| `options.html`, `options.js` | Uygulama adresi ve anahtar; kaydederken erişim izni, `GET /api/v1/scrapers/import/check` ile bağlantı denemesi |

Sitenin sayfa düzeni değişirse önce `backend/src/engine/scrapers/selectors/` güncellenir, sonra `extractors.js` yeniden
üretilir ve eklenti `chrome://extensions` sayfasında yenilenir. Ayrıntı: [docs/SCRAPERS.md](../docs/SCRAPERS.md#tarayıcı-eklentisi-kullanıcının-açtığı-sayfa).
