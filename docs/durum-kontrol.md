# "Ne dinliyorum" durumu — 3 dakikalık kontrol (Windows)

Bu özellik (CONTRACT-V11-ACTIVITY) gerçek bir Windows bilgisayarda hiç
denenmedi. Müzik okuyucusu (gizli bir PowerShell işlemi) yalnızca sahte
verilerle test edildi. Aşağıdaki adımlar, yeni masaüstü sürümü kurulu bir
Windows 10/11 bilgisayar ve sunucuda o sırada çevrimiçi bir arkadaş (ya da
telefonundan/başka bir tarayıcıdan aynı sunucuya girmiş ikinci bir hesap)
ile yapılır.

## Hazırlık (30 sn)

1. Trio masaüstü uygulamasını aç, sunucuya gir.
2. Ayarlar › Hesap › **Durum** › Müzik: "Ne dinlediğimi göster" işaretli,
   "Tarayıcılarda ve diğer uygulamalarda çalanları da göster" **işaretsiz**
   olmalı (ilk açılıştaki hâli).
3. Arkadaşın Üyeler listesine (telefonda: üstteki çevrimiçi rozetine dokun)
   bakıyor olsun.

## 1. Spotify'da bir şarkı (1 dk)

1. Spotify uygulamasında bir şarkı başlat.
2. Trio'da üstte tek satırlık bir bant çıkmalı: "Ne dinlediğin sunucudaki
   herkese görünüyor · Kapat / Tamam". **Tamam**'a bas. (Bant çıkmadıysa
   Ayarlar › Hesap › Durum'daki kırmızı satırı yaz.)
3. **Beklenen:** ~10 saniye içinde arkadaşın senin adının altında
   "♪ Sanatçı — Şarkı" görür (sesli odada olman gerekmez). Senin Üyeler
   listende de görünür.
4. Ayarlar › Hesap › Durum'da "Windows’un bildirdiği son oynatıcı: …" satırını
   **aynen** not et (ör. `Spotify.exe` ya da `SpotifyAB.SpotifyMusic_…!Spotify`).
5. Bir sonraki şarkıya geç: en geç ~10 saniyede yeni şarkı görünmeli.

## 2. Durdur (45 sn)

1. Spotify'da duraklat.
2. **Beklenen:** şarkı adı ~30 saniye daha görünür, sonra arkadaşının
   ekranından kaybolur (en geç ~40 sn).
3. Spotify'ı tamamen kapat (tepsiden çık): görünüyorsa birkaç saniyede gider.

## 3. YouTube sekmesi (45 sn)

1. Chrome ya da Edge'de bir YouTube videosu oynat (Spotify kapalıyken).
2. **Beklenen:** arkadaşın **hiçbir şey görmez**. Ayarlar'daki "son
   oynatıcı" satırı tarayıcıyı ve "gösterilmiyor"u söyler — not et.
3. İsteğe bağlı: "Tarayıcılarda ve diğer uygulamalarda çalanları da göster"i
   işaretle → video başlığı arkadaşına görünür; işareti kaldır → bir saniye
   içinde gider.

## 4. Gözle bakılacaklar (sürekli)

- Hiçbir adımda **siyah bir konsol penceresi yanıp sönmemeli**.
- Görev Yöneticisi'nde, "Ne dinlediğimi göster" açıkken bir
  `Windows PowerShell` işlemi olur (Trio'nun altında); ayar kapatılınca
  (ve müzik paylaşmıyorken) kaybolmalı.
- "Müzik durumu okunamadı: …" ya da "Windows medya oturumu okunamadı…"
  satırı çıkarsa metnini aynen gönder.

## Geri bildirim

Şunları gönder: her adımın "oldu / olmadı"sı, "son oynatıcı" satırlarında
gördüğün adlar (Spotify, tarayıcı, varsa Apple Music/TIDAL/Deezer/foobar2000),
ve kırmızı satırlar. Bu adlar sözleşmedeki uygulama listesini (§4)
doğrulamak için gerekiyor.
