/**
 * "Yenilikler" (CONTRACT-V4 A2): what changed, newest first, in Turkish. Each
 * entry is a version of the web client and 2–5 short lines. Add the next
 * release's entry at the top in the same commit that bumps package.json.
 *
 * 0.2.1 is the name given here to the account, theme and message-fix work that
 * went live while package.json still said an older number.
 */
export interface ChangelogEntry {
  version: string
  /** Only for a version split into several entries: what this part is about. */
  title?: string
  lines: string[]
}

export const CHANGELOG: readonly ChangelogEntry[] = [
  {
    version: '0.9.1',
    lines: [
      'Masaüstü uygulaması yeni sürümü artık kendisi fark ediyor: yayımlandıktan sonra birkaç dakika içinde arka planda indirir, sesli odadayken de.',
      'Güncelleme hazır olunca üstte bir satır, ayarlar düğmesinde bir nokta ve tepsi menüsünde “Yeniden başlat ve güncelle” görünür; görüşmedeyken kendiliğinden yeniden başlamaz.',
      'Uygulamadan çıkmadan bilgisayarı kapattıysan, güncelleme bir sonraki açılışta kurulur.',
    ],
  },
  {
    version: '0.9.0',
    title: 'Gruplar için',
    lines: [
      'Kim hangi kanalda: metin kanallarının altında o an kimin baktığı görünür; “Ayarlar › Hesap › Hangi kanalda olduğumu göster” ile kapatabilirsin.',
      'Başlıktaki “Üyeler” düğmesi her pencere boyutunda üye listesini açar; ekran ölçeklendirmesinde de kimin çevrimiçi olduğunu görürsün.',
      'Trio artık 15 kişiye kadar gruplar için: ses odasında en çok 8 kişi; doluysa “Oda dolu (8/8)” yazar.',
      'Mesajda @ yazınca kişiler listelenir; ok tuşlarıyla seçip Enter’la eklersin.',
      'Kalabalık görüntülü sohbette kameralar daha hafif gönderilir; çok görüntü varsa “+N · Hepsini göster”.',
    ],
  },
  {
    version: '0.8.1',
    lines: [
      'Trio artık her küçük grup için: site, giriş ekranı ve tüm metinler buna göre yenilendi; sitede “Kendi sunucunu kur” bölümü var.',
      'Proje MIT lisansıyla açık kaynak.',
    ],
  },
  {
    version: '0.8.0',
    title: 'Masaüstü kendini güncelliyor',
    lines: [
      'Masaüstü uygulaması artık kendini güncelliyor (Windows ve Linux AppImage): yeni sürüm arka planda iner, “Yeniden başlat ve güncelle” ile ya da uygulamadan çıkınca kurulur. Sesli odadayken kendiliğinden yeniden başlamaz.',
      'Bu son elle kurulum: 0.8.0’ı bir kez indirip kur, sonrası kendiliğinden gelir.',
      'Ayarlar › Hakkında’da güncelleme durumu, “Güncellemeleri denetle” düğmesi ve otomatik indirmeyi kapatma seçeneği.',
      'Yalnız sunucuyu ilgilendiren sürümlerde masaüstü uygulaması artık “yeni sürüm var” demiyor.',
      'Mac’te (uygulama imzasız) güncelleme hâlâ elle; bildirim bu Mac’e uygun dosyayı doğrudan indiren bir düğme gösteriyor.',
    ],
  },
  {
    version: '0.7.1',
    lines: [
      'İndirme sayfası yenilendi: Trio’nun neler yaptığını canlı örneklerle gösteriyor; bağlantıyı bir arkadaşına attığında önizlemesi de düzgün görünüyor.',
      'Giriş ekranı aynı havaya kavuştu.',
    ],
  },
  {
    version: '0.7.0',
    title: 'Müzik paylaş',
    lines: [
      'Müzik paylaş: bilgisayarında çalan sesi (Spotify, bir YouTube sekmesi…) sesli odadaki herkese stereo olarak gönder. Mikrofonunu sessize alsan da müzik çalmaya devam eder.',
      'Chrome/Edge’de müziğin çaldığı sekmeyi seç ve “Sekme sesini de paylaş”ı işaretle. Windows 11 masaüstü uygulamasında tek tıkla sistem sesi paylaşılır; odadaki konuşmalar müziğe karışmaz.',
      'Kimin ne çaldığı odada görünür: notalı işaret ve “Şu an çalıyor”. Şarkı adını göstermek isteğe bağlı.',
      'Her paylaşanın müziği için ayrı ses düzeyi ve susturma (kişinin üstüne sağ tık ya da uzun bas); kulaklığı kapatmak müziği de susturur.',
    ],
  },
  {
    version: '0.6.0',
    title: 'Telefonda kullanım',
    lines: [
      'Telefonda görüşmedeyken alttaki şeritten sessize al, kulaklık, kamera ve ayrıl tek dokunuşla; kim konuşuyor da orada.',
      'Telefonda kimin çevrimiçi olduğunu ve hangi ses odasında olduğunu üst çubuktan ya da menüden gör.',
      'Paylaşılan ekranı ve kameraları telefonda küçültüp sohbete dön; görüntü akmaya devam eder.',
      'Ayarlar bölümlere ayrıldı: Ses, Görüntü, Bildirimler, Hesap, Depolama, Hakkında. Çıkış yap artık Ayarlar › Hesap’ta.',
      'Telefonda Enter yeni satır açar, mesajı “Gönder” ile yollarsın.',
    ],
  },
  {
    version: '0.6.0',
    title: 'Okuma ve kanallar',
    lines: [
      'Okuduğun yer artık tüm cihazlarında aynı: telefonda okuduğun kanal bilgisayarda da okunmuş görünür.',
      'Okunmamış mesajı olan kanal “Yeni mesajlar” çizgisinde açılır; yukarıdayken sağ alttaki düğme kaç yeni mesaj geldiğini gösterir ve en alta götürür.',
      'Kanala sağ tıkla ya da basılı tut: yeniden adlandır; sunucunun sahibi kanalı silebilir. Kanal eklemek için tek “+”.',
      'Cihaz kodunun yanında karekod: telefonunun kamerasıyla okut, kod kendiliğinden yazılır.',
      'Bağlantı testi görüşme sırasında artık baştan başlamıyor.',
    ],
  },
  {
    version: '0.5.0',
    title: 'Bildirimler ve medya',
    lines: [
      'Telefonuna bildirim: Trio kapalıyken de yeni mesajlardan, seni ananlardan ve çağrılardan haberin olur (Ayarlar › Bildirimler; iPhone’da önce Trio’yu ana ekrana ekle).',
      'Kanal başına bildirim düzeyi (Hepsi / Yalnız @ben / Kapalı), sessiz saatler, @ad ve @herkes ile anma.',
      'Fotoğraflar gönderilmeden önce küçültülüyor ve konum bilgisi siliniyor; istersen “Orijinali gönder”. Sohbette resimler daha hızlı açılıyor.',
      'Kanal başlığındaki “Medya” düğmesi: tüm fotoğraflar, videolar, bağlantılar ve dosyalar tek yerde.',
      'Sesli mesaj: mikrofona basılı tut, konuş, bırak. Yarım kalan mesajın kanal değiştirince ya da sayfa yenilenince kaybolmuyor.',
    ],
  },
  {
    version: '0.5.0',
    title: 'Ses ve ekran paylaşımı',
    lines: [
      'Ekran paylaşımında profil seç: Oyun (akıcı), Metin (keskin), Film. Paylaşılan ekranı izlemeyi bırakabilirsin; görüntü sana gönderilmez.',
      'Herkesin sesini ayrı ayarla (%0–200); ayar bu cihazda hatırlanır.',
      'Giriş hassasiyeti: eşiğin altındaki ses gönderilmez. 10 dakika hareketsiz kalınca AFK görünür ve mikrofonun kapanır.',
      'Kısayollar: Ctrl+Shift+M / Ctrl+Shift+D; masaüstü uygulamasında pencere arkadayken de çalışan tuşlar.',
    ],
  },
  {
    version: '0.5.0',
    title: 'Yönetim, depolama ve indirme',
    lines: [
      'Ayarlar › Depolama: ne kadar yer kullandığını gör, eski dosyalarını sil; silinen dosya mesajda “dosya silindi” olarak kalır.',
      'Sunucu sahibine Ayarlar › Yönetim: kişiler, disk, sunucu ve TURN durumu, yedek indirme, hata kayıtları; kilitlenen arkadaşa cihaz kodu.',
      'Kalıcı disk bağlı değilse herkes kırmızı bir uyarı görür.',
      'Masaüstü uygulaması artık sunucunun /indir sayfasından indiriliyor; sayfa Windows/macOS uyarısı çıkarsa ne yapacağını anlatır.',
      'Masaüstü uygulamasının sürümü Ayarlar’da; yeni sürüm çıkınca haber verilir.',
    ],
  },
  {
    version: '0.4.0',
    title: 'Sesli görüşme',
    lines: [
      'Sunucu yeniden başlarken ya da bağlantın kısa bir süre kopunca sesli görüşme kesilmiyor; üstte “ses sürüyor” yazar.',
      'Ses odasında “Çağır” ile arkadaşlarını odaya çağırabilirsin; çağrı zil sesi ve bildirimle gelir (Ayarlar › Sesler’de “Rahatsız etme”).',
      'Sessize alma, kulaklık, odaya giren ve çıkan için kısa uyarı sesleri; Ayarlar › Sesler’den kısılır ya da kapatılır.',
      'Ayarlar › Bağlantı testi; katılımcı satırlarında bağlantı göstergesi ve “Mikrofon bağlantısı kesildi” uyarısı.',
      'Kamerayı ve ekran paylaşımını tekrar tekrar açıp kapatmak artık görüşmeyi bozmuyor; ekranın sesi yalnız “Ekran sesini de paylaş” seçiliyse gider.',
    ],
  },
  {
    version: '0.4.0',
    title: 'Mesajlar ve oyun durumu',
    lines: [
      'Mesajlara tepki: üstüne gel ya da telefonda basılı tut, bir emoji seç; kimin verdiğini üzerine gelince görürsün.',
      'Yanıtla: alıntı yanıtın üstünde durur, tıklayınca asıl mesaja gider. Önemli mesajları sabitle; başlıktaki Sabitlenenler hepsini gösterir.',
      'Kendi mesajını yerinde düzenle (boş yazı kutusunda ↑ son mesajını açar) ya da sil; düzenlenen mesajda “(düzenlendi)” yazar.',
      'Oyun durumu: Trio masaüstü uygulamasıyla oynadığın oyunun adı, adının altında görünür (Ayarlar › Oyun durumu’ndan kapatılır). WoW’da seviye ve bölge için TrioDurum eklentisi gerekir; bu kısım deneysel.',
    ],
  },
  {
    version: '0.3.0',
    lines: [
      'Profil fotoğrafı: Ayarlar › Hesap’tan bir görsel seç, kırp ve yükle; herkes hemen görür.',
      'Adını Ayarlar › Hesap’tan değiştirebilirsin; eski mesajlarında da yeni adın görünür.',
      'Sunucunun adı ve simgesi artık Ayarlar › Sunucu’dan değiştirilebiliyor.',
      'Ayarların altında uygulamanın ve sunucunun sürümü yazıyor.',
    ],
  },
  {
    version: '0.2.1',
    lines: [
      'Cihaz kodu ile telefonundan ya da başka bir tarayıcıdan aynı hesapla girebilirsin.',
      'Davet bağlantısı, bu cihazdan çıkış ve başka yerden kapatılan oturumlar.',
      'Yeni görünüm: Trio paleti, marka işareti ve boş ekran çizimleri.',
      'Bağlantı kopunca mesajlar kaybolmuyor, iki kez görünmüyor; okuduğun yer korunuyor.',
    ],
  },
  {
    version: '0.2.0',
    lines: [
      'Mesajlara dosya ve görsel eklenebiliyor (sürükle-bırak ve yapıştır dahil).',
      'Ses odasında kamera; birden fazla kamera ve ekran aynı anda.',
      'Ayarlar: mikrofon, hoparlör ve kamera seçimi.',
      'Bas-konuş ve RNNoise gürültü engelleme.',
    ],
  },
  {
    version: '0.1.0',
    lines: ['Metin kanalları, ses odaları ve ekran paylaşımı.', 'Üç arkadaş için, kendi sunucumuzda.'],
  },
]
