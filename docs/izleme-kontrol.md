# Oyun oynarken paylaşım izlemek — 5 dakikalık kontrol (Windows)

Mini oynatıcı (CONTRACT-V12-MINI-DESKTOP) yalnızca Linux'ta, sanal bir
ekranda (xvfb) ve sahte pencerelerle denendi. "Oyunun üstünde kalıyor mu",
"tıklamalar oyuna geçiyor mu", "odak çalınıyor mu" gibi asıl sorular ancak
gerçek bir Windows bilgisayarda ve gerçek bir oyunla cevaplanır. Gerekenler:
yeni masaüstü sürümü kurulu bir Windows 10/11, **pencereli tam ekran
(borderless)** ve **özel tam ekran (exclusive fullscreen)** seçeneği olan bir
oyun (ör. WoW, CS2, LoL), ve sesli odada ekranını paylaşan bir arkadaş (ya da
ikinci bir bilgisayar).

Her adımda gördüğünü "oldu / olmadı / tuhaf" diye not et; tuhafsa bir cümle
yeter.

## Hazırlık (1 dk)

1. Trio'yu aç, sesli odaya gir. Arkadaşın ekranını paylaşsın.
2. Ayarlar › Kısayollar'da izleme kısayollarını ata (önerilen):
   mini oynatıcı **Ctrl+Shift+F9**, tıklamayı geçir **Ctrl+Shift+F10**,
   sonraki paylaşım **Ctrl+Shift+F11**. Bas-konuş tuşunu bunlardan biri yapmaya
   çalış: ayarlar "Bu tuş bas-konuş tuşu; başka bir tuş seç." demeli.
3. Görev Yöneticisi'ni açık bırak (Ayrıntılar sekmesi, Trio satırları).

## 1. Açılınca odak çalmıyor mu (30 sn)

1. Paylaşımın üstündeki **mini oynatıcı** düğmesine bas ya da Ctrl+Shift+F9.
2. **Beklenen:** sağ altta küçük bir pencere açılır, arkadaşın ekranı oynar.
   Görev çubuğunda yeni bir simge **çıkmaz**.
3. Oyunu aç, içindeyken Ctrl+Shift+F9 ile kapat, tekrar aç.
   **Beklenen:** oyun odağı kaybetmez (karakter yürümeye devam eder, imleç
   oyunda kalır, oyun alta inmez).

## 2. Pencereli tam ekran (borderless) oyunun üstünde (1 dk)

1. Oyunun görüntü ayarını **Pencereli tam ekran / Borderless** yap.
2. **Beklenen:** mini oynatıcı oyunun üstünde kalır; oyun içinde birkaç kez
   tıklayıp dolaşınca da kaybolmaz.
3. Pencereyi kenar çubuğundan sürükleyip ekranın bir köşesine yaklaştır,
   bırak. **Beklenen:** köşeye "yapışır" (kenardan birkaç piksel içeride).
   Köşesinden büyüt: oranı (16:9) korunur, ekranın ~%60'ından büyük olmaz.
4. Trio'yu kapatıp açınca mini oynatıcı aynı köşede açılmalı.

## 3. Özel tam ekran (exclusive) — beklenen: ÜSTÜNDE KALMAZ (30 sn)

1. Oyunu **Tam ekran / Exclusive fullscreen** yap.
2. **Beklenen:** mini oynatıcı görünmez (Windows buna izin vermez). Oyun
   çökmemeli, takılmamalı; Alt+Tab ile çıkınca mini pencere yerinde olmalı.
   Görünürse ya da oyun titrerse yaz.
3. Oyunu tekrar borderless'a al.

## 4. Tıklamayı geçir ve geri almak (1 dk)

1. Mini oynatıcıda **tıklamayı geçir**'i aç (ya da Ctrl+Shift+F10).
2. **Beklenen:** mini pencerenin üstüne tıklayınca tıklama **oyuna** gider
   (oyunda o noktaya yürür/ateş eder); pencere sürüklenemez.
3. Oyundan çıkmadan **Ctrl+Shift+F10**'a bas. **Beklenen:** mini pencere
   yeniden tıklanabilir olur (bir düğmesine tıklayabilirsin).
4. Tekrar aç, bu sefer tepsideki Trio simgesine sağ tıkla:
   **"Mini oynatıcı: tıklamayı geri aç"** satırı görünmeli ve işe yaramalı.
   "Mini oynatıcıyı gizle / göster" satırını da dene.

## 5. Saydamlık ve oyun içi tuşlar (1 dk)

1. Mini oynatıcının saydamlık ayarını en aza çek. **Beklenen:** yarı saydam,
   ama hiçbir zaman tamamen görünmez değil.
2. Oyun odaktayken: Ctrl+Shift+F11 (sonraki paylaşım; odada iki paylaşım
   varsa) ve paylaşım sesini kısma/açma tuşları çalışmalı. Oyun da aynı
   tuşa tepki veriyorsa yaz (örn. oyunun kendi Ctrl+Shift kısayolu).
3. Oyun sohbetine `@` ve `€` yaz (AltGr+Q, AltGr+E): hiçbir izleme kısayolu
   tetiklenmemeli.

## 6. His: işlemci ve akıcılık (30 sn)

1. Mini oynatıcı açıkken ve kapalıyken Görev Yöneticisi'nde Trio'nun toplam
   CPU'suna bak; oyunun FPS'inde belirgin düşüş var mı?
2. Görüntü takılıyor mu, ses kayıyor mu? Bir cümle yaz.

## 7. İzleme biçimleri (Trio penceresinde, 1 dk)

1. Odada iki kişi paylaşsın. Sahnenin üstünde "Ayşe ve Mehmet ekran
   paylaşıyor" yazmalı; **Yan yana** ve **Odak** düğmeleriyle düzen değişmeli,
   Odak'ta ← → ile büyük olan değişmeli.
2. Bir paylaşımın ⋯ menüsünden **Sinema modu**: paylaşım Trio penceresini
   doldurur, birkaç saniye fareye dokunmayınca düğmeler kaybolur, biri
   sohbete yazınca altta kısa süre görünür, Esc çıkar.
3. ⋯ › **Hafif izleme** ve **Sadece ses**: Ayarlar › Görüntü › "Bağlantı
   bilgisini göster" açıkken üstteki satır küçük çözünürlük / az kare
   göstermeli; Sadece ses'te görüntü durur, ses sürer.
4. Ayarlar › Görüntü › "Trio arka plandayken paylaşılan ekranı mini
   oynatıcıda göster"i aç; Trio'yu tepsiye indir: mini oynatıcı kendiliğinden
   açılmalı, Trio'ya dönünce kapanmalı.

## İsteğe bağlı

- Kendi ekranını paylaşırken mini oynatıcı açık: arkadaşın kendi paylaşımını
  köşede görüyor mu? (Ayarlarda "Kendi paylaşımımda gizle" varsa açıp tekrar
  bak; Windows 10'un eski sürümlerinde siyah kutu görünebilir.)
- İki monitör: mini oynatıcıyı ikinci ekrana taşı, Trio'yu kapat-aç: orada
  açılmalı. İkinci ekranı çıkar: ana ekrana gelmeli.
