# Kurulum dosyalarını imzalamak

Trio'nun Windows ve macOS kurulum dosyaları bugün **imzasız**. Bu yüzden ilk
açılışta Windows "Windows bilgisayarınızı korudu", macOS "Apple, Trio'nun kötü
amaçlı yazılım içermediğini doğrulayamadı" der. İndirme sayfası (`/indir`) bu
uyarıyı dürüstçe anlatır, adım adım nasıl geçileceğini ve dosyanın gerçek
olduğunun SHA-256 ile nasıl doğrulanacağını gösterir. Uyarıyı **kaldıran**
tek şey imzadır, ve imza para (ya da başvuru) ister.

Sürüm iş akışı (`.github/workflows/release.yml`) imzaya hazır: aşağıdaki
GitHub sırları (Settings › Secrets and variables › Actions › New repository
secret) eklendiği an bir sonraki sürüm imzalı çıkar; sırlar yoksa her şey
bugünkü gibi imzasız çalışır. İş akışı imzanın gerçekten tuttuğunu kurulum
dosyası üzerinde denetler ve `signing.json` adlı küçük bir dosyayı sürüme
ekler; indirme sayfası imzalı platformun uyarı yardımını bununla gizler.
İmza yapılandırılmış ama tutmamışsa iş akışı **durur**, imzasız dosyayı imzalı
diye yayımlamaz.

Bu belgedeki fiyat ve koşullar 19 Kasım 2026'da web aramasıyla toplandı.
Hangisinin birinci elden (üreticinin kendi sayfası) hangisinin ikinci elden
doğrulandığı her maddede yazıyor. Satın almadan önce fiyatı üreticinin
sayfasında tekrar kontrol et.

---

## macOS: Developer ID + notarization (önerilen, hemen yapılabilir)

Başka bir proje için **Apple Developer Program** üyeliğin var (yıllık 99 $).
Aynı üyelikle Trio'yu da imzalayabilirsin; ek ücret yok. İmzalı ve Apple
tarafından onaylanmış ("notarize") bir uygulamada Gatekeeper uyarısı yerine
yalnız "İnternetten indirildi, açmak istiyor musun?" sorusu çıkar.

### 1. "Developer ID Application" sertifikası oluştur

1. Mac'te **Anahtar Zinciri Erişimi**'ni aç › menü **Anahtar Zinciri Erişimi ›
   Sertifika Asistanı › Bir Sertifika Yetkilisinden Sertifika İste**. E-posta
   adresini yaz, "Diske kaydedildi"yi seç, `CertificateSigningRequest.certSigningRequest`
   dosyasını kaydet.
2. <https://developer.apple.com/account/resources/certificates/list> › **+** ›
   **Developer ID Application** (dikkat: "Apple Development" ya da "Mac App
   Distribution" değil) › G2 Sub-CA'yı seçili bırak › az önceki CSR dosyasını
   yükle › indir (`developerID_application.cer`). Bu sertifikayı yalnız hesabın
   **Account Holder**'ı oluşturabilir.
3. `.cer` dosyasına çift tıkla; Anahtar Zinciri'ne (oturum) eklenir.
4. Anahtar Zinciri'nde **Sertifikalarım** altında "Developer ID Application:
   Adın (TEAMID)" satırını aç; altındaki özel anahtarla birlikte ikisini seç ›
   sağ tık › **2 öğeyi dışa aktar…** › biçim **.p12** › güçlü bir parola ver.
5. Terminal'de: `base64 -i Sertifikalar.p12 | pbcopy` — panoya base64 metni alır.

### 2. Notarization için App Store Connect API anahtarı

1. <https://appstoreconnect.apple.com/access/integrations/api> › **Team Keys** ›
   **+** › ad "Trio notarize", erişim **Developer** › **Generate**.
2. `AuthKey_XXXXXXXXXX.p8` dosyasını indir (yalnız bir kez indirilebilir).
   Sayfadaki **Key ID** ve en üstteki **Issuer ID**'yi not et.

### 3. GitHub sırları

| sır | değer |
|---|---|
| `CSC_LINK` | 1.5'teki base64 metin |
| `CSC_KEY_PASSWORD` | .p12 parolası |
| `APPLE_API_KEY` | `.p8` dosyasının **içeriği** (`-----BEGIN PRIVATE KEY-----` ile başlayan metnin tamamı) |
| `APPLE_API_KEY_ID` | Key ID |
| `APPLE_API_ISSUER` | Issuer ID |

Beşi birden yoksa iş akışı uyarı yazar ve bugünkü gibi ad-hoc imzalar. Varsa
electron-builder `mac.identity: "-"` yerine Developer ID ile imzalar, Apple'a
notarize ettirir, iş akışı sonucu `spctl` ile denetler ("source=Notarized
Developer ID"). Notarization Apple'da birkaç dakika sürer.

> **Not:** Bu sırlar telefonunla aynı Apple hesabının anahtarlarıdır; sızarsa
> biri senin adına Mac uygulaması imzalayabilir. Yalnız GitHub sırlarına koy,
> dosyaları sonra güvenli bir yerde sakla, gerekirse developer.apple.com'dan
> iptal et.

---

## Windows: seçenekler

SmartScreen uyarısı iki şeye bakar: dosyanın **imzalı** olması ve imzalayan
yayımcının (ya da dosyanın) **itibarı**. İtibar indirme sayısıyla zamanla
oluşur. Bu yüzden imza bile uyarıyı ilk günden kesin kaldırmaz; sayfa da
imzalı bir Windows dosyası için "yine de uyarırsa" satırını gösterir.

### a) Azure Artifact Signing (eski adı Trusted Signing) — ayda ~10 $

- Microsoft'un bulut imzası; electron-builder doğrudan destekliyor.
- **Bireyler için yalnız ABD ve Kanada'da açık** (Microsoft'un kendi
  quickstart ve Q&A sayfalarında yazıyor — birinci elden). Türkiye'deki bir
  birey olarak **başvuramazsın**. Kuruluşlar için daha çok ülke açık; bir şirket
  kurarsan Türkiye'nin listede olup olmadığını **doğrulayamadım**.
- Fiyat: Basic ~9,99 $/ay (ikinci elden; Microsoft'un fiyat sayfasında teyit et).
- İş akışında hazır: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`
  (Entra ID uygulama kaydı), `AZURE_SIGNING_ENDPOINT` (ör.
  `https://weu.codesigning.azure.net`), `AZURE_SIGNING_ACCOUNT`,
  `AZURE_SIGNING_PROFILE`, `AZURE_SIGNING_PUBLISHER` (sertifikadaki ad, aynen).

### b) OV / EV kod imzalama sertifikası — yıllık ~50–400 €

- Bir sertifika otoritesinden (Certum, Sectigo, SSL.com, DigiCert…) alınır,
  bireyler de alabilir (kimlik doğrulamasıyla).
- **EV artık anında SmartScreen itibarı vermiyor** (Microsoft Learn'in kod
  imzalama sayfası ve DigiCert'in bilgi bankası — birinci/ikinci elden). OV ile
  EV, SmartScreen açısından aynı: itibar zamanla oluşur. EV'ye fazladan para
  vermeye değmez.
- Haziran 2023'ten beri özel anahtar **donanımda** (USB token ya da bulut HSM)
  tutulmak zorunda; yani artık `.pfx` dosyası olarak verilmiyor. Bu, GitHub
  Actions'ta imzalamayı zorlaştırır: ya bulut HSM'li bir ürün (Certum
  SimplySign, SSL.com eSigner…) ve onun komut satırı aracı gerekir, ya da
  kendi Windows bilgisayarında token takılıyken elle imzalarsın.
- **Certum "Open Source Code Signing"**: bireylere, açık kaynak geliştiricisi
  olarak; Certum mağazasında bulut sürümü ~69 € gösteriliyor ama sayfalarda
  çelişkili fiyatlar var (ikinci elden; mağazada teyit et). CI'da çalıştırması
  SimplySign masaüstü aracına bağlı; GitHub'ın Windows sunucusunda çalıştığını
  **doğrulamadım**.
- İş akışında hazır olan yol: `WIN_CSC_LINK` (base64 `.pfx`) +
  `WIN_CSC_KEY_PASSWORD`. Yalnız elinde dışa aktarılabilir eski tip bir
  sertifika varsa işe yarar; bulut HSM'li bir sertifika alırsan ona özel bir
  imza adımı eklemek gerekir (electron-builder'ın `win.signtoolOptions.sign`
  kancası).

### c) SignPath Foundation — ücretsiz, ama açık kaynak şartı

- Açık kaynak projelere ücretsiz imza (sertifika SignPath Foundation adına).
- Şartlar (signpath.org — birinci elden): OSI onaylı bir lisans, ticari çift
  lisans yok, kötü amaçlı yazılım yok, imzalayan ekip depo sahibi ekip, iki
  aşamalı doğrulama. Depo **herkese açık** olmalı (bu, ikinci elden bir rehberde
  yazıyor; resmi sayfada açıkça bulamadım).
- Trio'nun deposu özelse bu yol kapalı. Depoyu açmak **sunucunun davet kodunu
  ya da verileri açığa çıkarmaz** (onlar Railway'de), ama kod herkese açık olur.
  Karar senin.

### d) Microsoft Store — bireyler için ücretsiz

- Eylül 2025'ten beri bireysel geliştirici hesabı **ücretsiz** (Windows
  Developer Blog, 10 Eylül 2025 — birinci elden; şirket hesabı tek seferlik
  99 $). Kimlik doğrulaması kimlik kartı + selfie ile.
- Mağazadan kurulan MSIX paketini Microsoft imzalar; SmartScreen uyarısı
  çıkmaz. electron-builder `appx` hedefini üretebilir.
- Ama: mağaza incelemesi, mağaza sayfası, ve uygulamanın her sürümde
  mağazaya gönderilmesi gerekir; arkadaşlar uygulamayı `/indir`'den değil
  Microsoft Store'dan kurar. Bu iş akışına **bağlanmadı** (gönderim elle).
  Mağazanın bir sunucu adresi soran "özel" bir sohbet uygulamasını kabul
  edip etmeyeceğini doğrulayamadım.

### Önerim

1. **macOS'u şimdi imzala**: üyeliğin zaten var, maliyeti sıfır, uyarı tamamen
   kalkar. Yukarıdaki üç adım yarım saat.
2. **Windows'ta şimdilik imzasız kal**, sayfadaki yardım ve SHA-256 doğrulaması
   üç-beş arkadaş için yeterli. Uyarı ilk açılışta bir kez çıkar.
3. Windows uyarısı gerçekten sorun olursa sırayla: depo açık kaynak olabiliyorsa
   **SignPath Foundation** (ücretsiz); olamıyorsa **Microsoft Store** (ücretsiz,
   ama mağaza süreci); en son yıllık ücretli bir **OV** sertifika (bulut HSM'li,
   CI'ya özel imza adımıyla). EV'ye ve Azure'a (bireysel olarak erişilemiyor)
   para verme.

---

## Linux

AppImage için imza yaygın değil ve masaüstleri uyarı göstermez; yalnız
`chmod +x` gerekir. Sayfa bunu anlatır.

## Kaynaklar

- Microsoft Learn — Code signing options for Windows app developers
  (EV/OV itibarı, Artifact Signing uygunluğu)
- Microsoft Learn — Quickstart: Set up Artifact Signing (bireyler: ABD/Kanada)
- DigiCert Knowledge Base — EV-signed application showing SmartScreen warnings
- signpath.org/terms — SignPath Foundation koşulları
- Windows Developer Blog, 10 Eylül 2025 — Free developer registration for
  individual developers on Microsoft Store
- shop.certum.eu — Open Source Code Signing (fiyatlar çelişkili)
- electron-builder (app-builder-lib 26.18) şeması: `win.azureSignOptions`,
  `mac.notarize`, `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER`
- macOS Sequoia: Control+tık ile açma kaldırıldı, "Yine de Aç" Gizlilik ve
  Güvenlik'te (9to5Mac, iDownloadBlog, Michael Tsai, Ağustos 2024 — ikinci elden)
