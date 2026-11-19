# Müzik paylaşımı — gerçek Windows'ta elle kontrol

CONTRACT-V8-MUSIC'in masaüstü kısmı Linux'ta yalnızca birim testleriyle (sahte
nesnelerle) ve Electron/Chromium kaynak kodu okunarak doğrulandı. Sesin
kendisini ancak gerçek bir Windows bilgisayar doğrular. **2 kişi, 5 dakika.**

- **Paylaşan (A):** Windows 11, Trio masaüstü uygulamasının bu sürümü,
  kulaklık takılı.
- **Dinleyen (B):** herhangi bir cihaz (tarayıcı ya da uygulama), kulaklık takılı.

## Hazırlık

1. A ve B aynı sesli odaya girer, birbirini duyduğunu doğrular.
2. A, Spotify'da (ya da Chrome'da YouTube'da) bir şarkı çalar.

## Kontroller

| # | Ne yapılır | Beklenen | Sonuç |
|---|---|---|---|
| 1 | A müzik paylaşımını başlatır | Seçici penceresi **açılmaz**; paylaşım hemen başlar | ☐ |
| 2 | B dinler | B şarkıyı duyar (net, stereo) | ☐ |
| 3 | B konuşur, birkaç cümle | B **kendi sesini geri duymaz** (yankı yok, gecikmeli tekrar yok) | ☐ |
| 4 | A dinler | A şarkıyı **bir kez** duyar (iki kat / yankılı değil) | ☐ |
| 5 | A mikrofonunu kapatır | B şarkıyı duymaya devam eder | ☐ |
| 6 | Şarkı adını göster açıkken | B'de doğru şarkı adı ve sanatçı görünür; şarkı değişince ≤5 sn'de değişir | ☐ |
| 7 | A Spotify'ı duraklatır | Şarkı adı kaybolur (ya da "bilinmiyor" olur) | ☐ |
| 8 | A paylaşımı durdurur | B'de müzik ve şarkı adı kaybolur; Görev Yöneticisi'nde Trio'nun açtığı `powershell.exe` ≤5 sn'de kapanır | ☐ |
| 9 | Paylaşım sırasında ekrana bakılır | Hiçbir konsol penceresi yanıp sönmez | ☐ |

3 numara olmazsa (B kendi sesini duyuyorsa) **hemen durdurun**: o paylaşım
odanın sesini geri gönderiyor demektir. Uygulamanın sürümünü, Windows
sürümünü (`winver`) ve hangi uygulamadan müzik çalındığını not edip bildirin.

## Windows 10'da (varsa)

| # | Ne yapılır | Beklenen | Sonuç |
|---|---|---|---|
| 10 | A (Windows 10) müzik paylaşımını başlatmayı dener | Paylaşım **başlamaz**; "Windows 11 gerektiriyor … Chrome'da sekmeyi paylaş" açıklaması görünür | ☐ |

## Ekran paylaşımı bozulmadı mı?

| # | Ne yapılır | Beklenen | Sonuç |
|---|---|---|---|
| 11 | A normal ekran paylaşımını başlatır | Eskisi gibi seçici açılır; "sistem sesi" kutusu eskisi gibi çalışır | ☐ |
