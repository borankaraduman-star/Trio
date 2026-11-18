# Trio masaüstü uygulaması

Trio'nun Windows, macOS ve Linux için masaüstü uygulaması. Electron ile yazılmış
ince bir kabuk: arayüzün kendisi sizin Trio sunucunuzdan gelir; uygulama ona
şunları ekler:

- **Küresel bas-konuş (PTT):** Trio penceresi arka plandayken, oyundayken bile
  tuşa basılı tuttuğun sürece mikrofon açılır.
- **Ekran paylaşımı için kaynak seçici:** ekranlar ve pencereler, küçük
  önizlemelerle. Windows'ta isteğe bağlı olarak sistem sesi de paylaşılır.
- **Tepsi simgesi:** pencereyi kapatınca uygulama tepside çalışmaya devam eder
  (sesli odadan düşmezsin). Tam çıkmak için tepsi menüsünden ya da
  `Trio → Çıkış` ile (Ctrl/Cmd+Q).
- **Okunmamış sayısı** görev çubuğunda / Dock'ta rozet olarak.

## İlk açılış

Uygulama ilk açılışta sunucu adresini sorar (ör. `https://trio.up.railway.app`).
Adres `https://` olmalı; `http://` yalnızca `localhost` / `127.0.0.1` için kabul
edilir. Uygulama `<adres>/api/health` adresini kontrol eder, adresi kaydeder ve
Trio'yu açar. Adresi sonradan değiştirmek için menüden **Trio → Sunucuyu
değiştir…**.

Menüde ayrıca **Yeniden yükle** (Ctrl/Cmd+R) ve **Geliştirici araçları**
(Ctrl+Shift+I, macOS'ta Alt+Cmd+I) vardır. Windows ve Linux'ta menü çubuğu
gizlidir; **Alt** tuşuna basınca görünür.

## Geliştirme

Node.js 22 gerekir.

```bash
cd desktop
npm install
npm run dev
```

`npm run dev` TypeScript'i derler ve uygulamayı açar. Yerel bir sunucuya
bağlanmak için bağlantı sayfasına `http://localhost:8000` (FastAPI) ya da
`http://localhost:5173` (Vite geliştirme sunucusu, `/api` ve `/ws` 8000'e
yönlendirilir) yaz. Her açılışta yazmamak için adresi ortam değişkeniyle de
verebilirsin; bu yol kaydedilmez:

```bash
TRIO_SERVER_URL=http://localhost:5173 npm run dev
```

Diğer komutlar:

| komut | ne yapar |
|---|---|
| `npm run typecheck` | yalnızca tür denetimi |
| `npm test` | derler ve birim testlerini çalıştırır (`node:test`): adres doğrulama, `KeyboardEvent.code` → tuş kodu eşlemesi, başlıktan okunmamış sayısı, köken kontrolleri, PTT denetleyicisi, sağlık kontrolü |
| `npm run build` | `dist/` klasörüne derler, yerel sayfaları ve simgeyi kopyalar |
| `npm start` | derlenmiş uygulamayı açar |

Linux'ta, eşleme tablosunu `uiohook-napi`'nin kendi tablosuyla karşılaştıran
test bir X ekranı ister; ekran yoksa atlanır. Hepsini çalıştırmak için:
`xvfb-run -a node --test "dist/test/**/*.test.js"`.

Linux'ta Electron'un kum havuzu (sandbox) kullanıcı ad alanları kapalıysa
açılmayabilir; o durumda geliştirme sırasında `npx electron . --no-sandbox`
kullan.

## Kurulum dosyası üretmek (yerelde)

```bash
npm run dist:win     # Windows: release/Trio-<sürüm>-win-x64.exe (NSIS)
npm run dist:mac     # macOS:   release/Trio-<sürüm>-mac-x64.dmg ve -arm64.dmg
npm run dist:linux   # Linux:   release/Trio-<sürüm>-linux-x86_64.AppImage
```

Her işletim sistemi kendi kurulum dosyasını en güvenilir şekilde kendisi
üretir (macOS `.dmg` yalnızca macOS'ta üretilebilir). Bu yüzden asıl yol
aşağıdaki GitHub Actions iş akışıdır.

## Sürüm yayınlamak

`.github/workflows/desktop-release.yml`, `v` ile başlayan her etikette
(`v0.2.0` gibi) Windows, macOS ve Linux makinelerinde uygulamayı derler,
testleri çalıştırır, kurulum dosyalarını üretir ve hepsini o etiketin GitHub
sürümüne (Release) ekler. Sürüm numarası etiketten alınır.

```bash
git tag v0.2.0
git push origin v0.2.0
```

Birkaç dakika sonra GitHub'daki **Releases** sayfasında `.exe`, iki `.dmg`
(Intel ve Apple Silicon) ve `.AppImage` dosyaları olur. İmzalama sırrı
kullanılmaz.

## İmzasız sürüm uyarıları

Kurulum dosyaları bir geliştirici sertifikasıyla imzalanmadığı için işletim
sistemi ilk açılışta uyarır. Bu beklenen bir durumdur.

### Windows (SmartScreen)

Kurulumu çalıştırınca mavi bir **"Windows bilgisayarınızı korudu"** penceresi
çıkar ve yayımcı "Bilinmeyen yayımcı" olarak görünür. **Daha fazla bilgi**
bağlantısına tıkla, ardından **Yine de çalıştır** düğmesine bas. Tarayıcı da
indirirken "yaygın olarak indirilmiyor" diyebilir; indirilenler listesinden
**Sakla** seç.

### macOS (Gatekeeper)

Uygulama "ad-hoc" imzalıdır, Apple tarafından onaylanmış (notarize) değildir.
`.dmg`'yi açıp Trio'yu **Uygulamalar** klasörüne sürükle. İlk açılışta
**"Trio" açılmadı / Apple, Trio'nun kötü amaçlı yazılım içermediğini
doğrulayamadı** uyarısı çıkar:

1. Uyarıyı **Bitti** ile kapat.
2. **Sistem Ayarları → Gizlilik ve Güvenlik**'i aç, aşağı kaydır.
3. "Trio engellendi…" satırının yanındaki **Yine de Aç** düğmesine bas,
   parolanı gir, sonra tekrar **Aç**.

(macOS 14 ve öncesinde uygulamaya Control+tıklayıp **Aç** demek de yeter;
macOS 15'te bu kısayol kaldırıldı.)

Uygulama "hasarlı" diye açılmıyorsa karantina işaretini kaldır:

```bash
xattr -dr com.apple.quarantine /Applications/Trio.app
```

### macOS izin pencereleri

Trio şu izinleri ister; hepsi **Sistem Ayarları → Gizlilik ve Güvenlik**
altından sonradan da açılıp kapatılabilir:

- **Mikrofon** ve **Kamera:** sesli odaya girdiğinde / kamerayı açtığında.
  Uygulamanın Info.plist'inde açıklaması vardır.
- **Ekran Kaydı (Ekran ve Sistem Sesi Kaydı):** ilk ekran paylaşımında. Kaynak
  seçicideki önizlemeler ve paylaşımın kendisi bu izni ister. İzni verdikten
  sonra macOS genellikle uygulamayı yeniden başlatmanı ister.
- **Giriş İzleme / Erişilebilirlik:** bas-konuş tuşu ayarlandığında. Küresel
  tuş dinleyici, Trio arka plandayken basılan tuşları görebilmek için bu izne
  ihtiyaç duyar. İzin yoksa uygulama yine çalışır, yalnızca bas-konuş tuşu
  algılanmaz. İzni verdikten sonra Trio'yu kapatıp yeniden aç.

Ad-hoc imza her sürümde değiştiği için macOS bu izinleri **güncellemeden sonra
yeniden sorabilir**; Ayarlar'daki eski Trio satırını kaldırıp yeniden izin
vermek gerekebilir.

## Platforma özgü notlar

- **Sistem sesi** paylaşımı yalnızca **Windows**'ta vardır (Electron bu
  "loopback" sesi şimdilik yalnızca Windows'ta destekliyor). Seçicideki kutu
  varsayılan olarak kapalıdır: bilgisayardan çıkan **tüm** ses gider, buna
  Trio'daki arkadaşlarının sesi de dahildir; yani onlar kendi seslerini
  yankı olarak duyabilir. Video ya da oyun sesi paylaşırken aç.
- **Linux, Wayland:** ekran paylaşımı PipeWire / xdg-desktop-portal üzerinden
  çalışır; seçicide tek bir kaynak görünür ve sistemin kendi penceresi asıl
  seçimi yapar. Küresel bas-konuş X11 (XWayland) üzerinden çalışır; saf
  Wayland uygulamalarına odaklıyken basılan tuşları göremeyebilir ve X
  ekranı hiç yoksa kapalı kalır.
- **Tepsi simgesi Linux'ta** masaüstü ortamının tepsi desteğine bağlıdır
  (GNOME'da "AppIndicator" eklentisi gerekir).
- **Okunmamış rozeti:** macOS Dock'ta sayı, Windows'ta görev çubuğu simgesinin
  üstünde kırmızı rozet, Linux'ta yalnızca destekleyen başlatıcılarda (KDE,
  Unity).

## Güvenlik

- Sayfalar `contextIsolation`, `sandbox` açık, `nodeIntegration` kapalı
  çalışır; `webSecurity` hiçbir zaman kapatılmaz.
- Pencere yalnızca kayıtlı sunucunun kökeninde (şema + alan adı + port)
  gezinebilir; başka adresler sistem tarayıcısında açılır.
- Mikrofon, kamera, ekran paylaşımı, bildirim (ve tam ekran, ses çıkış aygıtı
  seçimi, panoya yazma) izinleri yalnızca o kökene verilir.
- Ana süreç her IPC mesajında gönderen çerçevenin kökenini denetler.
- Uygulamanın kendi sayfaları (`trio-app://local/…`) paketin içinden gelir,
  ağa erişmez.

## Yapı

```
desktop/
  src/main/       ana süreç (main.ts), PTT denetleyicisi, ayar dosyası, sağlık kontrolü, rozet
  src/preload/    sandbox'lı preload betikleri (window.trioDesktop köprüsü, seçici)
  src/shared/     saf yardımcılar: adres doğrulama, tuş eşlemesi, başlık ayrıştırma
  src/test/       birim testleri
  static/         bağlantı sayfası ve kaynak seçici (HTML/CSS/JS)
  resources/      electron-builder kaynakları: simge, macOS yetkileri (entitlements)
  scripts/        derleme yardımcıları (simge çizimi, statik dosyaların kopyalanması)
```
