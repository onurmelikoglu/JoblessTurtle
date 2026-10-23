# Chrome Web Mağazası — mağaza metni ve paketleme notu

Mağazada yayımlanırsa kullanıcılar eklentiyi Geliştirici modu açmadan, tek tıkla kurar ve güncellemeler kendiliğinden
gelir. Yayını depo sahibi yapar; bu dosya başvuru formuna yapıştırılacak metinleri ve paketleme adımlarını toplar.
Bu dosya ve diğer `.md` dosyaları pakete girmez.

## Paketleme

1. `manifest.json` içindeki `version` değerini yükselt (mağaza aynı sürümü ikinci kez kabul etmez). Sayfa okuyucular
   değiştiyse önce `cd backend && npm run extension:extractors`.
2. Depo kökünde paketi üret (web imajındaki indirme paketiyle aynı içerik):

   ```bash
   (cd browser-extension && zip -qr -X ../jobless-turtle-extension-$(node -p "require('./manifest.json').version").zip . -x '*.md' '*.pem' '*.crx' '.*' '*/.*')
   ```

3. [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) › **Yeni öğe** › zip'i yükle.
   Güncellemede aynı öğenin **Paket** sekmesinden yeni zip yüklenir.
4. Mağaza görselleri: simge `icons/icon-128.png`; en az bir ekran görüntüsü 1280×800 ya da 640×400 (ilan sitesinde
   "Jobless Turtle'a aktar" düğmesi ve aktarım bildirimi; kişisel veri görünmesin, kurgusal profil kullan).
5. Gizlilik politikası adresi gerekir: depodaki README ya da ayrı bir sayfa; aşağıdaki "Veri kullanımı" metni yeterli.

`browser-extension.pem` (depo kökünde, `.gitignore`'da) yalnızca `.crx` paketlemek içindir; mağaza kendi anahtarını
kullanır, pem yüklenmez. Mağazadan kurulan eklentinin kimliği (ID) paketlenmemiş kurulumdan farklıdır; uygulama
kimliğe bağlı değildir, eşleştirme kodu ikisinde de çalışır.

## Mağaza metinleri

**Ad:** Jobless Turtle — ilan aktarıcı

**Kısa açıklama (en çok 132 karakter):**
Kariyer.net, Indeed ve diğer iş sitelerinde açtığın arama sayfasındaki ilanları kendi Jobless Turtle uygulamana aktarır.

**Kategori:** Verimlilik (Productivity) · **Dil:** Türkçe

**Ayrıntılı açıklama:**

Jobless Turtle, kendi bilgisayarında ya da sunucunda çalıştırdığın açık kaynaklı bir iş arama asistanıdır. Bu eklenti,
Kariyer.net, Indeed, Eleman.net, İşin Olsun, Secretcv ve Yenibiriş'te kendi tarayıcında açtığın arama sonuç
sayfasındaki ilanları okuyup yalnızca senin uygulamana gönderir; uygulama ilanları profiline göre süzer ve listeler.

- Sağ alttaki "Jobless Turtle'a aktar" düğmesiyle o sayfadaki ilanları aktarırsın; uygulamadan açtığın aramalarda her
  sonuç sayfası kendiliğinden aktarılır.
- Siteye kendi başına istek atmaz, gezinmez, tıklamaz, sayfaya bir şey yazmaz. Sayfada güvenlik doğrulaması varsa
  aktarım yapmaz; doğrulamayı aşmaya çalışmaz.
- Kurulum: uygulamada Kurulum › Tarayıcı eklentisi › "Eşleştirme kodunu kopyala", kodu eklentinin ayarlarına yapıştır.

Uygulama ayrıca gerekir: https://github.com/onurmelikoglu/JoblessTurtle

## Tek amaç (single purpose)

Kullanıcının açtığı iş ilanı arama sonuç sayfasındaki ilan bilgilerini, kullanıcının kendi Jobless Turtle uygulamasına
aktarmak.

## İzin gerekçeleri

| İzin | Gerekçe |
|---|---|
| `storage` | Kullanıcının girdiği uygulama adresi ve eklenti anahtarını saklamak. |
| `scripting` | Uygulama köprüsünü (`app-bridge.js`) yalnızca kullanıcının kaydettiği uygulama adresine kaydetmek; köprü uygulamaya eklentinin kurulu olduğunu bildirir ve "Hepsini aç" ile arama sekmelerini açar. |
| İçerik betiği eşleşmeleri (6 iş sitesinin arama sayfaları) | Kullanıcının açtığı arama sonuç sayfasındaki ilan kartlarını okumak ve aktar düğmesini göstermek. |
| İsteğe bağlı host izni (`http://*/*`, `https://*/*`) | Uygulama her kullanıcıda farklı adreste çalışır (localhost, kendi alan adı). İzin yalnızca kullanıcının kaydettiği tek adres için, kaydederken istenir. |
| Uzak kod | Kullanılmaz; bütün betikler pakettedir. |

## Veri kullanımı (gizlilik formu)

- Toplanan veri: açık arama sayfasındaki ilan bilgileri (başlık, firma, konum, ilan adresi, tarih). Kişisel veri,
  kimlik bilgisi, tarama geçmişi toplanmaz.
- Veri yalnızca kullanıcının ayarlarda girdiği kendi uygulama adresine gönderilir; geliştiriciye ya da üçüncü tarafa
  gitmez, satılmaz, reklam için kullanılmaz.
- Saklanan: uygulama adresi ve eklenti anahtarı (`chrome.storage.local`), sekme başına otomatik aktarım işareti
  (`sessionStorage`).
