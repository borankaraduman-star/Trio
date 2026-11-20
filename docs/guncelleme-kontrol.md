# Masaüstü güncellemesini elle denetlemek (5 dakika)

Uygulamanın kendini güncellemesi (CONTRACT-V10-UPDATE) testlerde sahte bir
güncelleyiciyle denendi; **gerçek bir makinede, gerçek bir GitHub sürümüyle
hiç denenmedi**. Bu liste onu bir kez denemek için.

Gereken: bir Windows bilgisayar (asıl hedef), istersen bir Linux masaüstü ve
bir Mac. İki sürüm: kurulu olan **N** ve yayımlanacak **N+1**. N, bu özelliği
taşıyan ilk sürüm ya da sonrası olmalı (0.7.1 ve öncesi kendini güncelleyemez).

## Yol A: bir sonraki gerçek sürümle (en kolayı)

1. N kurulu ve açık olsun (Ayarlar › Hakkında: "Masaüstü uygulaması N",
   altında "Güncel").
2. N+1'i her zamanki gibi yayımla (`release.yml`).
3. Sürüm sayfasında şu dosyaların olduğuna bak: `latest.yml`,
   `latest-linux.yml`, `latest-mac.yml`, `Trio-N+1-win-x64.exe.blockmap`,
   `Trio-N+1-mac-arm64.zip`, `Trio-N+1-mac-x64.zip`. İş akışındaki "Check update
   metadata" adımı yeşil olmalı.
4. **Hiçbir şeye basma, bekle.** Açık uygulama yeni sürümü kendisi fark
   etmeli: sayfa `/api/downloads`'ı 5 dakikada bir sorar (sunucu GitHub'ı 10
   dakika önbellekte tutar), yeni sürümü görünce kabuğa "şimdi bak" der. En
   geç ~15 dakika içinde bant "Güncelleme indiriliyor: N+1 (%…)" ve ayarlar
   düğmesinde turuncu nokta çıkmalı. (Sesli odadayken de olmalı.) Sürenin
   kaç dakika olduğunu not et. Olmazsa Ayarlar › Hakkında › **Güncellemeleri
   denetle** yine çalışır (20 Kas 2026'da 0.8.0 → 0.9.0 böyle çalıştı).

## Yol B: ön sürümle (kimseyi etkilemeden)

Kararlı bir sürüm kullanan uygulama ön sürümleri (`-rc.1` gibi) **görmez**.
Bu yüzden önce bir ön sürüm kur, sonra bir sonrakini yayımla:

1. `gh workflow run release.yml --ref <dal> -f version=0.9.0-rc.1 -f ref=<dal>`
   → `Trio-0.9.0-rc.1-win-x64.exe`'yi indirip kur.
2. `gh workflow run release.yml --ref <dal> -f version=0.9.0-rc.2 -f ref=<dal>`
3. rc.1 uygulamasında **Güncellemeleri denetle**.
4. Bitince iki ön sürümü GitHub'dan sil (kurulu rc uygulaması bir sonraki
   kararlı sürüme kendisi geçer).

## Windows'ta neye bakılır

- [ ] Durum satırı sırayla: "Güncellemeler denetleniyor…" → "İndiriliyor %…"
      (yüzde artıyor) → "Hazır: N+1 — yeniden başlatınca kurulur".
- [ ] Uygulamanın üstünde bant: **Güncelleme hazır: N+1 — Yeniden başlat ve
      güncelle** ve **Sonra**.
- [ ] Tepsi simgesinin üstüne gel: "Trio — Güncelleme hazır: N+1". Tepsi
      menüsünde **Yeniden başlat ve güncelle (N+1)**.
- [ ] Pencere tepsideyken (kapatılmış) hazır olursa bir kez sessiz bildirim:
      "Trio güncellemesi hazır".
- [ ] Bir sesli odaya gir: bantta düğme kaybolur, "sesli odadan çıkınca
      kurulabilir" yazar; Hakkında'daki düğme ve tepsi menüsündeki satır gri.
      Uygulama kendiliğinden yeniden başlamaz.
- [ ] Hazır güncellemeyle bilgisayarı kapat (uygulamadan çıkmadan), aç, Trio'yu
      başlat: birkaç saniye sonra pencere kapanır ve N+1 olarak açılır
      ("sonraki açılışta kurulur"; sesli odaya kendiliğinden girdiyse kurmaz).
- [ ] Odadan çık, **Yeniden başlat ve güncelle**: pencere kapanır, kurulum
      ekranı **çıkmadan** birkaç saniyede Trio N+1 olarak yeniden açılır.
      Sunucu adresi ve ayarlar yerinde. (SmartScreen'in araya girip girmediğini
      not et: imzasız kurulum sessiz güncellemede de uyarı verebilir.)
- [ ] Hakkında: "Masaüstü uygulaması N+1", "Güncel".
- [ ] Kurulum klasörü değişmedi (ilk kurulumda başka klasör seçtiysen orada
      kaldı): Ayarlar › Uygulamalar › Trio.
- [ ] İkinci yol: hazır güncellemeyle **Çıkış** (tepsi menüsü) yap (kurulum
      sessizce yapılır, Trio kendisi açılmaz), Trio'yu yeniden aç → N+1.
- [ ] Kendiliğinden indirme kapalıyken (Hakkında'daki kutu): bant "yeni sürümü
      var (N+1)" + **İndir** der; İndir'e basınca iner.
- [ ] Ağı kes, **Güncellemeleri denetle**: "Güncelleme denetlenemedi (internet
      bağlantısı yok)".
- [ ] İndirmenin fark (blockmap) ile yapılıp yapılmadığı: Görev Yöneticisi ›
      Performans › Ethernet/Wi-Fi'de inen miktar (tam indirme ~80–100 MB).
      İndirilen dosya `%LOCALAPPDATA%\trio-desktop-updater\pending\` içinde
      durur. Fark indirme ancak N'nin sürümünde de blockmap varsa olur; yoksa
      tam indirir, bu da doğru.

## Linux (AppImage) neye bakılır

- [ ] AppImage dosyasını çalıştırarak aç (çıkarılmış klasörden değil).
- [ ] Windows'taki adımlar; yeniden başlatınca **aynı dosya adı** yeni sürümle
      değişmiş ve açılmış olmalı.
- [ ] AppImage'ı `--appimage-extract` ile çıkarıp çalıştırırsan Hakkında'da
      "Kendiliğinden güncelleme yalnız AppImage olarak çalışırken olur" yazar
      ve bant elle indirme düğmesini gösterir.

## macOS'ta ne beklenir

İmzasız Mac uygulaması **kendini güncelleyemez** (macOS buna izin vermez).
Beklenen:

- [ ] Hakkında: "Bu Mac'te güncellemeler elle kurulur: uygulama imzasız…"
- [ ] Bant: "Masaüstü uygulamasının yeni sürümü var (N+1)." ve **bu Mac'in
      işlemcisine uygun** tek indirme düğmesi ("İndir (Apple Silicon)" ya da
      "İndir (Intel)"); tıklayınca dosya tarayıcıda iner.

Developer ID imzası açıldıktan sonra (docs/imzalama.md) ilk imzalı sürüm bir
kez elle kurulur; ondan sonraki sürümde Mac de Windows gibi kendini
güncellemeli: aynı listeyi Mac'te tekrarla.

## Eski uygulamalar (0.4.0–0.7.1) neye bakılır

- [ ] Eski uygulamayı aç (sunucu yeni sürümdeyken): bant "yeni sürümü var
      (N)" der, yanında **İndir** düğmesi doğrudan bu sistemin kurulum dosyasını
      indirir (sayfaya değil). Windows ve Linux'ta "Bu son elle kurulum: bundan
      sonra uygulama kendini güncelleyecek." yazar.
- [ ] İndirilen kurulumu çalıştır: eski uygulamanın üstüne kurulur, sunucu
      adresi yerinde.

## Sorun çıkarsa

Uygulamanın kendi güncelleme günlük dosyası yok. Uygulamayı bir terminalden
başlat (Windows: `"%LOCALAPPDATA%\Programs\Trio\Trio.exe"`, Linux: AppImage
dosyasının yolu) ve çıktıdaki `[trio] updater` satırlarına bak. Ham hata
kullanıcıya gösterilmez, yalnız kısa Türkçe neden.
