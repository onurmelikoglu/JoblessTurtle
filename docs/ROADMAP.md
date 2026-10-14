# Yol haritası — v1.1

Kaynak: 13 Ekim 2026 tarihli 13 maddelik istek listesi. Her madde olduğu gibi değil, aynı amaca en iyi hizmet eden biçimiyle ele alındı; aşağıdaki tabloda hangi maddenin hangi fazda ve nasıl karşılandığı yazıyor.

## Çıkış noktası (13 Ekim 2026)

İlk sürümün kullanımında görülen sorunlar:

- Açık ilanların çok azı aranan ya da yakın unvanlarla eşleşiyordu (madde 3, 13).
- Gönderilen başvuruların kayda değer bir kısmı geri dönüyordu (madde 2, 8).
- Yapay zekâ görevlerinin yarıdan fazlası tekrar eden mail adresi aramasına gidiyordu (madde 10).
- Kuyruklar boşken arayüz "Başvurular hazırlanıyor" diyordu; günlerce `running` kalan görevler vardı (madde 7).
- "Diğer firmalar" başlığı altında neredeyse tamamına zaten başvurulmuş firmalar listeleniyordu (madde 6).
- Çalışma alanları arasında paylaşım yoktu; her çalışma alanı aynı firmayı ayrı araştırıyordu (madde 2, 10).

Sonuç: ilanlar yalnızca keşfedilen firmaların kendi kariyer sayfalarından geldiği için ilgili ilan sayısı çok düşük; AI bütçesinin büyük kısmı tekrar eden adres aramasına gidiyor; arayüz gerçek işi değil birikmiş işi gösteriyor.

## Maddelerin karşılığı

| # | İstek | Nasıl ele alınıyor | Faz |
|---|---|---|---|
| 1 | Arama çubuğu şehir, iş vb. arasın | Tek arama kutusu firma adı, ilan başlığı, şehir/ilçe, sektör ve mail adresinde arar; listede yoksa aynı metinle "kurum ekle" ya da "bu aramayla ilan tara" önerilir | 1 (yerel), 3 (hedefli tarama) |
| 2 | Firmalar ortak kayıt olsun; yeni hesapta aramadan çıksın; ulaşan mail adresleri bilinsin | Çalışma alanlarından bağımsız **ortak firma kataloğu** ve **adres teslim sicili**; yeni profil kaydında katalogdan eşleşen firmalar AI çağrısı olmadan eklenir | 2 |
| 3 | İlan azlığı; LinkedIn, Kariyer.net, Indeed ve AI araması | Unvan odaklı **ilan arama motoru**: AI web araması (platform ilanları dahil), açık API'li ATS ve uzaktan çalışma panoları, sayfa doğrulaması | 3 |
| 4 | İlgisiz ilanlar görünmesin; üçlü sınıf; çalışan sayısı ve filtresi | Firma düzeyinde üç sınıf (açık ilan / geçmişte açmış / potansiyel); ilgisiz ilanlar arayüzden kalkar; çalışan sayısı alanı ve aralık filtresi | 1 (sınıf, gizleme), 2 (çalışan sayısı) |
| 5 | Kendi AI modelimizi eğitelim | **Öğrenen sistem**: deneyim defteri → kendi verimizle eğitilen hafif modeller (teslim, yanıt, ilgi) → istemlere işe yarayan örneklerin eklenmesi → ince ayara hazır veri seti | 2 (veri toplama), 5 (modeller) |
| 6 | "Diğer firmalar" nedir; başvurulanlar görünmesin | Başlık kalkar; başvurulan firmalar "Başvurmadığım firmalar"da hiç listelenmez | 1 |
| 7 | Sürekli "hazırlanıyor" | Durum gerçek işe bağlanır: şu an çalışan iş, sıradaki otomatik tarama, bekleyen iş ayrı gösterilir; takılı görevler temizlenir | 1 |
| 8 | Hatalı adresler bir daha seçilemesin, aramada hariç tutulsun | Kalıcı **ölü adres listesi**: seçenekten kalkar, elle girilemez, AI yeniden bulsa da kaydedilmez, her adres aramasına "bunlar dışında" olarak verilir | 2 |
| 9 | Form, LinkedIn vb. başvuru butonları | İlan/firma başına başvuru kanalları (firma formu, ATS, LinkedIn, Kariyer.net, kariyer sayfası, firmanın yanıtında verdiği bağlantı) ayrı buton olur | 1 (eldeki bağlantılar), 3 (platform ilanları) |
| 10 | Kendi kendine işleyen otomasyon; hata türüne göre düzeltip tekrar gönderme; AI optimizasyonu | **Otopilot**: başvuru başına durum makinesi, mail dönüşü kategorisine göre otomatik karar, AI görev yönlendirici ve bütçe | 4 |
| 11 | İsim ve logo | Marka adı, logo, renk, web ikonları ve giriş ekranı | 1 |
| 12 | Her sekmede arama, filtre, kontrol | Ortak araç çubuğu: arama, filtre çipleri, sıralama, toplu işlem; üç sekmede aynı düzen | 1 |
| 13 | Daha derin, tekrarsız, TR ve yurt dışı; başarılı gönderimlerle öğrenen arama | Sorgu planlayıcı (verim takibiyle rotasyon), kaynaklar arası tekilleştirme, TR/yurt dışı kapsamı, öğrenilmiş sıralama | 3, 5 |

## Faz 1 — Arayüz toparlama ve kontrol

Amaç: Ekranda görülen her şey doğru ve kullanıcının elinde olsun. Madde 1, 4, 6, 7, 9, 11, 12.

**Durum (13 Ekim 2026):** geliştirme tamamlandı. Bu fazda arayüz Flutter web'den React'e taşındı (karar ve gerekçe: [PLAN.md](PLAN.md)); marka adı **Jobless Turtle** oldu.

- **Üç sınıf.** Her firma tek bir sınıfa düşer: *açık ilan* (hedef veya yakın unvanda açık, ya da açıklığı teyit edilemeyen ilan), *geçmişte açmış* (ilgili ilan kapanmış), *potansiyel* (ilgili ilan hiç görülmemiş). Sınıfı olmayan firma listelenmez.
- **İlgisiz ilanlar.** "Diğer N ilanı gör" ve toplam açık ilan sayısı kalkar; yalnızca eşleşen ilan sayısı gösterilir.
- **Başvurulanlar.** "Başvurmadığım firmalar"da başvurulan firma hiçbir koşulda listelenmez; "Diğer firmalar" başlığı kalkar.
- **Durum paneli.** Dört durum: *çalışıyor* (hangi iş, kaç tane), *beklemede* (son tarama, sıradaki otomatik tarama), *durduruldu*, *AI hakkı bekleniyor*. Gösterge yalnızca gerçekten çalışan iş varken döner. 30 dakikadan uzun `running` kalan AI görevi zaman aşımına düşürülür.
- **Araç çubuğu.** Firmalar: arama, sınıf, bölge, mail adresi durumu, yazı durumu, sıralama. Başvurular: arama, teslim durumu, tarih, sıralama. Mail dönüşleri: arama, kategori. Seçim ve toplu işlem aynı çubukta.
- **Başvuru kanalları.** Her satırda eldeki bağlantılar buton olur: ilan formu, kariyer sayfası, firmanın "buradan başvurun" yanıtındaki bağlantı; ardından "Başvurdum".
- **Marka.** Ad, logo, tema rengi, favicon, PWA ikonları, giriş ekranı, sekme başlığı.

Kabul: Kuyruk boşken gösterge dönmez. Başvurulan firma ilk sekmede görünmez. Arama kutusuna şehir veya unvan yazınca eşleşen firmalar süzülür. Flutter logosu hiçbir yerde kalmaz.

## Faz 2 — Ortak firma hafızası ve adres bilgisi

Amaç: Bir kez bulunan bilgi herkes için bulunmuş olsun; bozuk adres bir daha kullanılmasın. Madde 2, 4 (çalışan sayısı), 8; madde 5 için veri toplama.

**Durum (13 Ekim 2026):** geliştirme tamamlandı. Geçiş, canlı verinin bir kopyasında prova edildikten sonra uygulandı: aynı firmanın kayıtları ortak katalogda birleşti, geçmiş gönderimler adres siciline işlendi ve çalışma alanları arasında adres ve ofis bilgisi paylaşılmaya başladı.

- **Ortak katalog** (çalışma alanından bağımsız): firma kimliği (alan adı; yoksa sadeleştirilmiş ad), site, kariyer sayfası, LinkedIn sayfası, sektörler, ofisler, çalışan sayısı aralığı, genel özet, yayımlanmış başvuru adresleri, takip edilen kariyer kaynakları, firmada görülen ilanlar ve firmanın hangi unvanlar aranırken bulunduğu. Yalnızca kamuya açık firma bilgisi tutulur; kimin başvurduğu, notlar, taslaklar ve role özel analiz çalışma alanında kalır.
- **Katalogdan ekim.** Profil kaydedilince (ve her gece) katalogdaki firmalardan unvan sinyali olanlar çalışma alanına AI çağrısı olmadan eklenir: firmada aranan/yakın unvanla ilan görülmüş ya da firma aynı unvan ailesi aranırken bulunmuş olmalı; başka şehirdeki ve hariç tutulan sektördeki firma eklenmez. Firma ofisleri, geçerli adresleri, kariyer kaynakları ve profille eşleşen kapanmış ilanlarıyla ("bu pozisyonu daha önce açmış") gelir. Kullanıcının sildiği firma yeniden önerilmez.
- **Önce katalog, sonra arama.** Adres araması başlamadan kataloğa bakılır; başka bir çalışma alanında bulunmuş yeni bir gönderilebilir adres varsa AI çağrısı yapılmaz. Gece turunda katalogdaki yeni adres, ofis ve çalışan sayısı bilgisi çalışma alanlarına dağıtılır.
- **Adres teslim sicili** (ortak): adres başına gönderim, teslim, geri dönüş ve yanıt sayısı ile durum (bilinmiyor / ulaşıyor / geçersiz). Teslim: firmadan yanıt ya da otomatik yanıt gelmesi, ya da gelen kutusu izlenen hesapta 72 saat içinde geri dönmemesi. Ulaştığı görülen adres tüm çalışma alanlarında doğrulanmış sayılır, alıcı sıralamasında öne geçer ve önizlemede "daha önce ulaştı" diye işaretlenir.
- **Ölü adres listesi.** Sunucunun kesin bildirdiği hatalar (adres yok, adres dışarıdan mail almıyor, alan adı mail almıyor) adresi kalıcı olarak kapatır: tüm çalışma alanlarında seçeneklerden kalkar, elle seçilemez ve eklenemez, yeniden bulunsa da kaydedilmez, ilanlardaki başvuru adresi olarak kullanılmaz, firmanın sonraki her adres aramasına "bunların dışındakileri ara" diye verilir. Geçici hatalar (kutu dolu, ek boyutu, gecikme) ve yapay zekânın yorumuna dayanan dönüşler adresi kalıcı olarak öldürmez. Ücretsiz posta sağlayıcıları ve daha önce mail ulaşmış alan adları topluca kapatılmaz.
- **Çalışan sayısı.** Keşif, firma raporu ve adres araması görülen çalışan sayısını yan bilgi olarak döndürür; eksikler 12 firmalık gruplar halinde tek AI çağrısıyla aranır (gece turu ve "Bilinmeyenleri bul"). Bulunan değer kataloğa yazılır, diğer çalışma alanları aramadan alır. Filtre: 1-10, 11-50, 51-200, 201-1.000, 1.000+, bilinmiyor.
- **Deneyim defteri.** Her gönderim (adres türü, yerel kısım, alan adı eşleşmesi, kaynak türü, başvuru türü, yazıyı üreten, gün/saat, firma büyüklüğü) sonucuyla birlikte (teslim, geri dönüş kategorisi, yanıt); her adres araması, keşif ve çalışan sayısı araması (sağlayıcı, model yükseltmesi, kaç adres bulundu) kaydedilir. Faz 5'in eğitim verisi buradan gelir; geçmiş 245 gönderim de işlendi.

Kabul: Yeni bir davetli hesabı profilini kaydettiğinde, katalogda eşleşen firmalar bir dakika içinde ve AI hakkı harcanmadan listesinde görünür. Geri dönen adres hiçbir ekranda yeniden seçilemez.

Sonraya kalan: unvan eşleşmesi şimdilik aynı dilde yazılmış unvanlara bakar ("Mobile Developer" ile "Mobil Uygulama Geliştirici" eşleşmez; yakın unvan önerisi iki dili de eklediği için pratikte kapanır). Türkçe/İngilizce unvan eşlemesi Faz 3'te ilan aramasıyla birlikte ele alınacak.

## Faz 3 — İlan arama motoru

Amaç: Aranan ve yakın unvanlardaki ilanların büyük kısmını bulmak; aynı sonucu tekrar getirmemek. Madde 3, 13, 9, 1.

**Durum (14 Ekim 2026):** geliştirme tamamlandı. Yapılanlar aşağıdaki planla aynı; farklar: HN "Who is hiring" ve WeWorkRemotely bağlayıcısı yazılmadı (ikincisi yapay zekâ aramasının kaynak listesinde), belirsiz unvanlar için toplu AI unvan analizi yerine Türkçe-İngilizce unvan eşlemesi genişletildi, sonuç listesi sayfalanmadı. Web aramasıyla bulunan ilanlar resmî kaynakla doğrulanana kadar otomatik başvuruya girmez; elle başvuru açıktır.

- **Kaynaklar.**
  - *AI web araması*: unvan × şehir × platform sorguları (LinkedIn iş ilanları, Kariyer.net, Indeed, Glassdoor, Youthall, Secretcv, Eleman.net, Wellfound ve benzeri). Model yalnızca gerçekten gördüğü ilanı bağlantısıyla döndürür.
  - *Açık API'li ATS'ler*: mevcut Greenhouse ve Lever'a ek olarak Workable, SmartRecruiters, Teamtailor, Recruitee, Ashby, Personio.
  - *Yurt dışı / uzaktan panolar*: Remotive, RemoteOK, Arbeitnow, WeWorkRemotely, Himalayas, HN "Who is hiring".
  - *Doğrulama*: bulunan ilan sayfası robots.txt izin veriyorsa okunur; JSON-LD `JobPosting` ile açıklık, son tarih ve varsa başvuru adresi çıkarılır.
- **Platformlara doğrudan bot yok.** LinkedIn, Indeed ve Kariyer.net'e oturum açan ya da arama sayfalarını kazıyan bot yazılmaz (kullanım koşulları, IP/hesap engeli, kırılganlık). Bu platformlardaki ilanlar AI web araması ve tekil ilan sayfasının izinli okunmasıyla gelir; kullanıcı ilana kendi hesabıyla tek tıkla gider.
- **İş alarmı mailleri (v1.1 sonrası eklendi).** Bu platformların taramaya kapalı ilanları için en eksiksiz kaynak sitenin kendi bildirimidir: kullanıcı sitede iş alarmı kurar, alarm mailleri bağlı gelen kutusundan okunur ve profile uyan ilanlar listeye eklenir (`engine/job-alerts.service.ts`).
- **Sorgu planlayıcı.** Her sorgunun (unvan, konum, kaynak) son çalışma zamanı ve yeni sonuç verimi tutulur; verimli sorgular sık, tükenenler seyrek çalışır. Bilinen ilan ve firma kimlikleri sorguya "bunlar hariç" olarak verilir.
- **Tekilleştirme.** Firma alan adı/ad eşlemesi ve firma + normalize unvan + şehir anahtarıyla aynı ilanın farklı kaynaklardaki kopyaları tek ilanda toplanır; her kopya ayrı başvuru kanalı butonu olur.
- **İlgililik süzgeci.** Yalnızca hedef/yakın unvanla eşleşen ilan kaydedilir; kural tabanlı eşleşme belirsizse toplu AI unvan analizi.
- **Kapsam.** Profilde Türkiye (şehirler) ve yurt dışı (uzaktan, ülke/bölge, taşınma) ayrı seçilir; sonuçlar buna göre gruplanır.
- **Hedefli tarama.** Arama kutusuna yazılan serbest metin ("Ankara fintech iOS") tek seferlik tarama olarak çalıştırılabilir.

Kabul: Aynı profil için eşleşen açık ilan sayısı en az on katına çıkar. Art arda iki taramada ikinci tarama, birincinin getirdiği ilanı yeni diye göstermez.

## Faz 4 — Otopilot ve AI optimizasyonu

Amaç: Bulma → araştırma → adres → yazı → gönderim → dönüş → düzeltme zinciri kullanıcı beklemeden işlesin. Madde 10.

**Durum (14 Ekim 2026):** geliştirme tamamlandı. Plandan farklar: durum makinesi ayrı bir kayıt olarak tutulmuyor, zincirin aşamaları mevcut kayıtlardan türetilip Otopilot panelinde sayılarla gösteriliyor; görev türü başına pay, görev türlerinin toplandığı beş öncelik sınıfı üzerinden uygulanıyor; "kutu dolu" dönüşünde yeniden deneme üç gün sonraya planlanıyor. Canlı verinin kopyasındaki prova: 32 açık dönüşten 9'u için düzeltme önerisi, 13'ü için "firma mail ile başvuru almıyor" notu üretildi; hiçbir mail gönderilmedi. Son yedi günün adres aramaları yeni hafıza kuralıyla yeniden oynatıldığında 1.158 yapay zekâ görevinin 396'sı gerekli kalıyor (yaklaşık üçte bir).

- **Durum makinesi** (başvuru başına): keşfedildi → araştırıldı → adres var / adres yok → yazı hazır → sırada → gönderildi → teslim / geri döndü / yönlendirildi / yanıtlandı → kapandı.
- **Dönüş kategorisine göre otomatik karar.**

| Dönüş | Karar |
|---|---|
| Adres yok / kapalı / alan adı geçersiz | Adres ölü listeye; bilinen sıradaki adrese gönder; yoksa hariç listesiyle tek araştırma; yine yoksa dur |
| "CV'nizi şu adrese gönderin" | Bildirilen adrese aynı yazıyla gönder |
| Biçim talimatı (konu, ilan kodu, dil) | Yazıyı talimata göre düzelt, gönder |
| "Kariyer sitesinden başvurun" | Mail denemesi durur; bağlantı başvuru butonu olur |
| Ek boyutu | Yalnızca CV ile gönder |
| Kutu dolu / gecikme | Planlı yeniden deneme |
| İnsan yanıtı, görüşme, ret | Takip iptal; kullanıcıya bildirim |
| "İletişime geçmeyin" | Firma kara listeye |

  Başvuru başına en çok iki otomatik düzeltme; "Otomatik başvur" kapalıyken düzeltmeler onaya düşer.
- **Adres bulunamayan firma.** Yükseltmeli tek tur aramadan sonra durulur; yeniden deneme 30 günde bir. Arayüzde yalnızca diğer kanallar gösterilir.
- **AI yönlendirici.** Görev türüne göre en ucuz yeterli model; yalnızca başarısızlık sinyalinde üst modele çıkış; toplu görevler (çalışan sayısı, unvan analizi); katalog ve sicil sayesinde atlanan aramalar; kural tabanlı sınıflama yetiyorsa AI çağrısı yok; öncelik sırası (etkileşimli > düzeltme > yazı > araştırma > keşif) ve görev türü başına günlük pay.
- **Görünürlük.** Otopilot günlüğü: ne yaptı, neden, ne kadar AI harcadı.

Kabul: Geri dönen bir başvuru, bilinen başka adres varsa kullanıcı dokunmadan bir sonraki gönderim penceresinde yeniden gider. Haftalık adres araması AI görevi en az yarıya iner.

## Faz 5 — Öğrenen sistem

Amaç: Her gönderim bir sonrakini iyileştirsin. Madde 5, 13.

**Durum (14 Ekim 2026):** geliştirme tamamlandı. Plandan farklar ve bugünkü gerçek durum:

- "Az veride düzleştirilmiş oran, çok veride lojistik regresyon" iki ayrı yöntem yerine tek bir düzenlileştirilmiş lojistik regresyonla sağlanıyor; düzenlileştirme az örnekte kestirimi temel orana çeker. Model, eğitimde görmediği örneklerde (beş katlı çapraz doğrulama) temel orandan en az %1 iyi çıkmadıkça **etkinleşmez** ve hiçbir kararı değiştirmez.
- İlk eğitimde veri az olduğu için teslim modeli bu eşiğin altında kaldı, yani pasif. Veri biriktikçe kendiliğinden etkinleşecek; o zaman alıcı sıralamasına girer. "Geri dönüş oranı ölçülür biçimde düşer" kabul ölçütü bu yüzden henüz gösterilemiyor; yönetici ekranındaki haftalık tablo bunu izlemek için var.
- Yanıt ve ilgi modelleri için örnek henüz çok az; ikisi de pasif. Etkinleştiklerinde fırsat listesinin sırasına girerler.
- Veriden şimdiden çıkan sonuç istemlere giriyor: firmanın kendi sitesinde bulunan adresler üçüncü taraf sitelerdekilerden belirgin biçimde daha sık ulaşıyor; bu ipucu adres aramasının istemine ekleniyor. Yanıt almış başvurulardaki firmaya özel paragraflar yeni yazılar için ton örneği oluyor.
- Gönderim zamanı (gün/saat) önerisi yapılmadı; veri bunu destekleyecek büyüklükte değil. İstem sürümü karşılaştırması, ipucu eklenmiş ve eklenmemiş aramaların başarı oranı olarak tutuluyor.

Claude ve ChatGPT abonelik CLI'ları ince ayara izin vermez; birkaç yüz örnekle büyük bir dil modeli eğitmek de anlamlı sonuç vermez. Bu yüzden "kendi modelimiz" üç katmandan oluşur:

1. **Kendi verimizle eğitilen hafif modeller** (gece yeniden eğitilir, sunucuda çalışır, AI hakkı harcamaz):
   - *Teslim modeli*: adres türü, yerel kısım kalıbı, alan adı eşleşmesi, kaynak türü, doğrulanmışlık, sicil → teslim olasılığı. Alıcı sıralaması ve otomatik gönderim eşiği.
   - *Yanıt modeli*: sınıf, sektör, çalışan sayısı, bölge, başvuru türü, dil, gün/saat → yanıt olasılığı. Fırsat sıralaması ve gönderim zamanı.
   - *İlgi modeli*: kullanıcının başvurduğu ve gizlediği fırsatlar → kişisel sıralama.
   Örnek sayısı azken düzleştirilmiş oranlar, yeterince veri birikince lojistik regresyon; yönetici ekranında örnek sayısı ve isabet ölçütü.
2. **İşe yarayan örneklerin istemlere eklenmesi**: adres aramasına benzer firmalarda teslim edilen adreslerin bulunduğu kaynak türleri; yazıya aynı adayın yanıt almış yazıları; keşfe yanıt getiren segment ve sorgular. İstem sürümleri sonuç ölçütleriyle karşılaştırılır.
3. **İnce ayara hazır veri seti**: deneyim defteri (istem, girdi, onaylanmış çıktı, sonuç) JSONL olarak dışa aktarılır. Veri birkaç bin örneğe ulaştığında yerel bir küçük modelin (Ollama) ince ayarı için hazırdır.

Kabul: Alıcı sıralaması teslim modeline göre yapılır ve geri dönüş oranı ölçülür biçimde düşer. Model ölçütleri yönetici ekranında görünür.

## Sıra ve bağımlılıklar

1 → 2 → 3 → 4 → 5. Deneyim defteri Faz 2'de başlar ki Faz 5'e gelindiğinde veri birikmiş olsun. Faz 3 kataloğa yazar (bulunan firma ve ilan herkese yarar). Faz 4, Faz 2'nin sicil ve ölü adres listesine dayanır.

Her faz sonunda: backend birim ve e2e testleri, web `typecheck`/`lint`/`test`, CHANGELOG girdisi, canlıya alma (`docker compose up -d --no-deps`).
