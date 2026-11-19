# TrioDurum — Trio'da oyun durumu

Trio, arkadaşlarının adının altında hangi oyunda olduklarını gösterir:
**"WoW Forever · 37 · Orgrimmar"**. Bunun iki katmanı var:

1. **Eklentisiz katman (her zaman):** Trio masaüstü uygulaması bilgisayarda
   çalışan programların ADLARINA bakar (Discord'un yaptığı gibi) ve tanıdığı
   bir oyun çalışıyorsa "World of Warcraft" ya da "Counter-Strike 2" gibi oyun
   adını ve ne kadardır oynandığını gösterir. Bunun için eklenti gerekmez.
2. **Eklentili katman (yalnızca WoW):** Bu klasördeki **TrioDurum** eklentisi
   karakterinin seviyesini ve bulunduğu bölgeyi oyunun kendi sohbet kaydı
   dosyasına yazar; Trio masaüstü bu dosyayı okur.

> **Dürüst not:** Bu eklenti yazılırken kimse WoW Forever'ı çalıştıramadı.
> Aşağıdaki her şey oyun dışında test edildi; oyunun içinde ne olacağını
> **senin denemen** gösterecek. Bu yüzden önce 2 dakikalık kontrolü yap.

---

## 0. Önce 2 dakikalık kontrol (her şeyden önce bunu yap)

Her adımın sonunda "olmadıysa" ne demek olduğu yazıyor. Bir adım tutmazsa
**durup Claude'a hangi adımda takıldığını yaz** — sonraki adımlara geçme.

1. **AddOns klasörü var mı?** Oyunun kurulu olduğu klasörde
   `_forever_\Interface\AddOns` (yoksa `_forever_\Interface` içinde
   `AddOns` adında bir klasör) var mı bak. Yoksa kendin oluştur.
   (Örnek yol: `C:\Program Files (x86)\World of Warcraft\_forever_\Interface\AddOns`.
   Klasörün adı `_forever_` değilse, içinde `WTF` ve `Logs` olan `_..._`
   klasörünü kullan.)
   - *Olmadıysa* (ne `_forever_` ne `Interface` var, klasör yapısı bambaşka):
     **bu yol bu istemcide mümkün olmayabilir — Claude'a "adım 1" de.**
2. **Eklenti oyunda görünüyor mu?** `TrioDurum` klasörünü (içindeki `.toc` ve
   `.lua` dosyalarıyla) `AddOns` klasörüne kopyala:
   `...\_forever_\Interface\AddOns\TrioDurum\TrioDurum.toc` olacak şekilde
   (iç içe `TrioDurum\TrioDurum\` olmasın). Oyunu aç. Karakter seçme
   ekranında sol altta **AddOns** düğmesi ya da üstteki **MENU** içinde
   **AddOns** seçeneği çıkıyor mu? Çıkıyorsa aç, **TrioDurum** listede mi, işaretli
   mi? Üstte **"Load out of date AddOns"** (güncel olmayanları yükle) kutusu
   varsa işaretle.
   - *Olmadıysa* (eklentiler kopyalandıktan sonra bile hiçbir AddOns düğmesi
     ya da menüsü yok): **bu istemci eklenti yüklemiyor olabilir; eklentili
     katman mümkün değil — Claude'a "adım 2" de.** Eklentisiz katman (oyun adı)
     yine çalışır, bkz. §3.
3. **Eklenti cevap veriyor mu?** Karakterle oyuna gir, sohbete `/trio test`
   yaz. Sohbette **"Trio: gönderildi: TRIO1;…"** gibi bir satır görmelisin.
   - "Trio: gönderilemedi: …" görürsen o mesajı aynen not al.
   - *Hiçbir şey olmadıysa* (ya da "bilinmeyen komut" dendiyse): **eklenti
     yüklenmemiş — Claude'a "adım 3" de** (ve adım 2'de ne gördüğünü).
4. **Sohbet kaydı açık mı?** Sohbete `/chatlog` yaz. Oyun "Chat logging
   enabled / Sohbet kaydı açık" gibi bir şey demeli. ("disabled/kapalı"
   derse bir kez daha `/chatlog` yaz.) Sonra `/trio durum` yaz: "sohbet
   kaydı: açık" görmelisin.
   - *Olmadıysa* (`/chatlog` bilinmeyen komut): **bu istemcide sohbet kaydı
     yok; canlı yol mümkün değil, yalnızca çıkışta kaydedilen bilgi kalır —
     Claude'a "adım 4" de.**
5. **Dosya oluşuyor ve büyüyor mu?** Oyun açıkken `/trio test` yaz ve
   `_forever_\Logs\WoWChatLog.txt` dosyasına bak (Not Defteri ile aç ya da
   Trio masaüstünde **Trio › Oyun durumu…** penceresindeki "Tanılama"ya bak).
   - Dosya var ve içinde `TRIO1;` ile başlayan satır **birkaç saniye içinde**
     görünüyorsa: **canlı yol çalışıyor.** Kaç saniye sürdüğünü not al.
   - Dosya var ama satır ancak `/reload` ya da oyundan çıkınca geliyorsa:
     **oyun kaydı geç yazıyor; canlı yol yok, Trio bilgiyi çıkışta/reload'da
     günceller — Claude'a "adım 5: geç" de** (kaç dakika beklediğini de yaz).
   - Dosya hiç yoksa ya da `TRIO1;` hiç yazılmıyorsa: `/trio mod kanal` yazıp
     `/trio test` ile bir daha dene (§2.4). O da olmazsa **Claude'a "adım 5:
     yok" de.**

Beşi de tuttuysa her şey hazır; aşağıdaki kurulum ayrıntıları seni ilgilendirmez.

---

## 1. Kurulum

1. `addon/TrioDurum` klasörünü `<WoW klasörü>\_forever_\Interface\AddOns\`
   içine kopyala.
2. Oyunda AddOns listesinde TrioDurum'u aç; gerekirse **Load out of date
   AddOns**'u işaretle. (Eklentinin `.toc` dosyasındaki arayüz numarası
   tahmindir: WoW Forever için 16001 yazdık, emin değiliz. Oyun "güncel değil"
   derse bu kutu yeter.)
3. Trio masaüstü uygulamasında **Trio › Oyun durumu…** menüsünü aç:
   - **Otomatik bul** ya da **Klasör seç…** ile WoW klasörünü göster
     (`_forever_` klasörünü ya da ana `World of Warcraft` klasörünü; ana klasörü
     seçersen içindeki sürümlerden birini seçmen istenir).
   - "Tanılama" bölümünde sohbet kaydı dosyasını, son `TRIO1` satırını ve ne
     kadar önce görüldüğünü göreceksin.
4. Trio'da **Ayarlar › Oyun durumu › Oyun durumumu paylaş** açık olsun
   (varsayılan açık).

## 2. Eklenti komutları

| komut | ne yapar |
|---|---|
| `/trio durum` | son gönderilen satır, gönderildi mi, sohbet kaydı açık mı, hangi mod |
| `/trio test` | hemen bir satır gönderir (denemek için) |
| `/trio mod fısıltı` | (varsayılan) satırı **kendine fısıldar** |
| `/trio mod kanal` | satırı özel bir kanala yazar (`TrioDurum`; değiştirmek için `/trio kanal <ad> [şifre]`) |
| `/trio mod kapalı` | hiçbir şey göndermez; bilgi yine de çıkışta kaydedilir |
| `/trio gizle açık/kapalı` | kendi `TRIO1` satırlarını sohbet penceresinde gizle/göster (varsayılan gizli) |
| `/trio kayıt açık/kapalı` | girişte sohbet kaydını (`/chatlog`) kendiliğinden aç (varsayılan açık) |
| `/trio hedef Ad-Diyar` | fısıltı kendi adına gitmiyorsa (ör. adında boşluk olan karakter) hedefi elle yaz; boş bırakırsan kendin |

### 2.4 Hiçbir şey görünmüyorsa denenecekler (sırayla)

1. `/trio durum` → "sohbet kaydı: KAPALI" ise `/chatlog` yaz.
2. `/trio gizle kapalı` → `/trio test`. Satırı sohbette görüyor musun?
   Görüyorsan ama dosyada yoksa: gizleme kayda engel oluyor olabilir; gizle
   kapalı kalsın ve dosyaya tekrar bak.
3. "gönderilemedi: …" diyorsa: karakter adında boşluk varsa (ör. "Kahve
   Kokusu") fısıltı hedefi kabul edilmiyor olabilir. `/trio hedef` ile adı
   farklı yazmayı dene (ör. `Kahve Kokusu-Diyar`), ya da `/trio mod kanal`.
4. `/trio mod kanal` → `/trio test`. Not: oyun, kanallara eklentinin kendi
   başına yazmasını büyük ihtimalle yalnızca senin bir tuşa basmana bağlı
   izin veriyor; bu modda `/trio test` çalışıp otomatik satırlar çalışmayabilir.
5. Zindanda, savaşta (karşılaşma, M+, PvP maçı) oyun eklentilerin mesaj
   göndermesini kilitler. Eklenti bekler ve kilit kalkınca gönderir — bu normal.
6. Hiçbiri olmazsa: Trio masaüstünde **Oyun durumu › Kopyala** ile tanılama
   metnini kopyalayıp Claude'a gönder.

## 3. Trio ne gösterir

| durum | arkadaşların görür |
|---|---|
| Oyun çalışıyor, eklenti canlı çalışıyor (sohbet kaydı anında yazılıyor) | **WoW Forever · 37 · Orgrimmar**, bölge değiştikçe birkaç saniye–dakika içinde değişir |
| Eklenti çalışıyor ama kayıt geç yazılıyor | oyun adı ve süre; seviye/bölge `/reload` ya da çıkışta güncellenir (üzerine gelince "Oyundan çıkarken kaydedilen bilgi") |
| Eklenti yok/çalışmıyor, oyun listede tanınıyor | yalnızca **World of Warcraft** (ya da eklediğin ad) ve kaç dakikadır oynandığı (üzerine gelince) |
| Oyun kapalı | hiçbir şey |

**WoW Forever'ın program adını bilmiyoruz.** Oyun açıkken Trio masaüstünde
**Oyun durumu › Oyunlar › Şu an çalışanlardan ekle**'ye bas, listeden oyunun
programını seç (ör. `Wow.exe`, `WowB.exe` ya da başka bir ad) ve görünecek adı
yaz: **WoW Forever**. Adında "wow" ya da "warcraft" geçen oyunlara eklenti
bilgisi (seviye, bölge) eklenir.

## 4. Gizlilik

- Trio masaüstü sohbet kaydı dosyasından **yalnızca `TRIO1;` ile işaretlenmiş
  satırları** okur. Diğer bütün sohbet satırları (fısıltılar, lonca, kanallar)
  bilgisayarından hiçbir yere gitmez: ne Trio sayfasına, ne sunucuya, ne de
  Trio'nun kendi kayıtlarına. Bu bir testle sınanıyor.
- Çalışan programların listesi de bilgisayarından çıkmaz; yalnızca tanınan bir
  oyunun ADI gönderilir. Programları yalnızca "Şu an çalışanlardan ekle"
  listesinde, kendi ekranında görürsün.
- "Kopyala" ile alınan tanılama metninde sohbetinden hiçbir şey, hesap adın ve
  seçtiğin klasör dışında hiçbir yol yoktur.
- Paylaşmak istemediğinde: Trio'da **Ayarlar › Oyun durumumu paylaş**'ı kapat.
  Bilgi hemen silinir ve bir daha gönderilmez.

## 5. Blizzard kuralları hakkında (bizim okumamız, garanti değil)

- Eklenti yalnızca oyunun resmi eklenti arayüzünü kullanır; hiçbir kütüphane,
  ağ bağlantısı ya da dosya erişimi yoktur (eklentiler bunları zaten yapamaz).
- Trio masaüstü yalnızca oyunun **kendisinin yazdığı** bir kayıt dosyasını
  okur ve işletim sisteminin program listesine bakar; oyunun belleğine ya da
  dosyalarına dokunmaz, oyuna hiçbir şey göndermez. Savaş kaydı (combat log)
  yükleyicileri de aynı yöntemle çalışır.
- Eklentinin otomatik gönderdiği tek şey: birkaç dakikada bir, **yalnızca
  kendine** bir fısıltı (ya da seçersen yalnızca sizin özel kanalınıza bir
  satır). Kimseye istenmeyen mesaj gitmez; sıklık sınırlıdır (en fazla 10
  saniyede bir, 10 dakikada 12).
- Bu bizim kuralları okuyuşumuzdur, **Blizzard'ın onayı değildir**. Oyunun
  kuralları değişebilir; kuşkun olursa eklentiyi kapat (`/trio mod kapalı`)
  ya da kaldır — eklentisiz katman yine oyun adını gösterir.

## 6. Doğrulanmamış olanlar (sen deneyince netleşecek)

- [ ] WoW Forever eklenti yüklüyor mu; `## Interface: 16001` doğru mu.
- [ ] `/trio test` kendine fısıldayabiliyor mu (adında boşluk olan karakterle).
- [ ] Fısıltı `Logs/WoWChatLog.txt` dosyasına yazılıyor mu; **kaç saniyede**.
- [ ] Gizlenen (`/trio gizle açık`) satırlar dosyaya yine yazılıyor mu.
- [ ] `/chatlog`'u eklentinin kendisi açabiliyor mu (girişte "sohbet kaydı açıldı" mesajı).
- [ ] Kanal modunda otomatik satırlar gidiyor mu, yoksa yalnızca `/trio test` mi.
- [ ] Çıkışta `WTF/Account/.../SavedVariables/TrioDurum.lua` oluşuyor mu.
- [ ] Oyunun program adı (`Oyun durumu` penceresindeki "İşlem listesi: tanınan").
- [ ] Zindanda/savaşta bekleyip sonra göndermesi.
