# SignPath Foundation başvurusu (Windows imzası, ücretsiz)

Amaç: Windows'taki "Windows kişisel bilgisayarınızı korudu" (SmartScreen)
uyarısını kaldırmak. Bunun yolu kurulum dosyasını güvenilen bir sertifikayla
imzalamak. SignPath Foundation açık kaynak projelere bunu **ücretsiz** yapıyor:
sertifika onların adına, imzayı onların donanım anahtarı (HSM) atıyor, biz
GitHub Actions'tan dosyayı gönderiyoruz. Diğer yollar (Microsoft Store, ücretli
OV sertifika) `docs/imzalama.md`'de.

Bu belgedeki her şey **senin yapacağın adımlar**; kod tarafı hazır
(`.github/workflows/release.yml`, `.github/actions/signpath-sign/`,
`desktop/scripts/signpath-bridge.cjs`). SignPath ayarları yokken sürüm iş akışı
bugünkü gibi imzasız çalışır.

> Bu belge 20 Kasım 2026'da yazıldı. signpath.org ve docs.signpath.io bu
> oturumun ağından **açılamadı**; şartlar arama sonuçlarındaki alıntılardan,
> SignPath'in kendi GitHub Action deposundan ve SignPath ile imzalanan başka
> açık kaynak projelerin belgelerinden derlendi. Başvurmadan önce
> <https://signpath.org/terms> ve <https://signpath.org/apply> sayfalarını bir
> kez kendin oku; bir şey farklıysa o sayfa doğrudur.

---

## Önce bil: sonuç ne olur, ne kadar sürer, reddedilebilir mi

- **Yayımcı adı "SignPath Foundation" görünür**, "Trio" ya da senin adın değil.
  Windows'un UAC/SmartScreen pencerelerinde ve dosyanın Özellikler › Dijital
  İmzalar sekmesinde bu yazar. Bu, ücretsiz programın bedeli.
- **SmartScreen uyarısının ilk günden kalkacağı garanti değil.** SmartScreen
  imzaya ve imzalayanın itibarına bakar. SignPath Foundation sertifikası birçok
  projede kullanıldığı için itibarının yüksek olması beklenir, ama bunu
  **doğrulayamadım**. İmzalı bir dosyada uyarı çıkarsa bile yayımcı "Bilinmeyen
  yayımcı" yerine "SignPath Foundation" görünür.
- **Kabul SignPath'in takdirinde, itiraz yok** (başvuranların aktardığı).
  Bekleme süresi için resmi bir rakam yok; başka projelerin yazdıkları bir
  hafta ile yedi hafta arası (bir proje yedi hafta sonra reddedildi; başvurunun
  durumunu sorgulamanın bir yolu yok).
- **Trio için açıkça risk olan noktalar** (dürüst olmak gerekirse, reddedilme
  ihtimali düşük değil):
  - Başkalarının aktardığına göre Foundation projenin **bilinirliğine** bakıyor
    (kullanıcı topluluğu, hakkında yazılanlar, indirme sayısı). Trio üç
    arkadaş için yapılmış, kamuya duyurulmamış bir uygulama.
  - Deponun git geçmişi **18 Kasım 2026'da** başlıyor (iki günlük görünüyor),
    sürümler 0.5.0–0.8.0 bu birkaç günde çıkmış.
  - **Tek bakımcı**; commit'lerin yazarı olarak "Claude"/"Codex" görünüyor
    (yapay zekâ asistanları). Bu kendi başına yasak değil (şartlarda böyle bir
    madde görmedim), ama inceleyen kişi "projeyi kim yönetiyor" diye bakacak:
    politika metni bunu açıkça söylüyor (aşağıda).
  - Şartlarda geçtiği aktarılan "Software must not include features that
    compromise the privacy or security of users" maddesi: Trio'nun global
    tuş dinleyicisi (bas-konuş için `uiohook-napi`) ve oyun/çalan müzik
    durumu okuma özellikleri inceleyende soru doğurabilir. Bunlar kullanıcının
    açtığı, yerel çalışan özellikler; formda kısaca açıkla (aşağıdaki metin
    bunu yapıyor).
  - Reddedilirsen: 6–12 ay sonra tekrar başvurulabileceği yazılıyor; o arada
    `docs/imzalama.md`'deki Microsoft Store ya da ücretli sertifika yolu kalır.

### Şartlar (doğrulayabildiğim kadarıyla)

| şart | kaynak | Trio |
|---|---|---|
| OSI onaylı açık kaynak lisans, ticari çift lisans yok, tüm bileşenler açık kaynak | signpath.org/terms (arama alıntısı, birinci elden) | MIT (`LICENSE`); bağımlılıklar `THIRD-PARTY-NOTICES.md` (hepsi açık kaynak; libuiohook LGPL-3.0, certifi MPL-2.0 — ikisi de açık kaynak) |
| Sertifika "SignPath Foundation" adına, Foundation yayımcı olur | signpath.org/terms (alıntı) | — |
| Ekip yalnız kendi projesini imzalar; tüm kaynak ve derleme betiklerini ekip yönetir | signpath.org/terms (alıntı) | evet |
| Roller: committer/reviewer (dışarıdan gelen her değişikliği inceleyen), approver (her imza isteğini onaylayan) | signpath.org/terms (alıntı) | sen, üç rol birden (README'de yazıyor) |
| Tüm ekip üyeleri GitHub'da ve SignPath'te **çok aşamalı doğrulama (MFA)** | signpath.org/terms (alıntı) | **senin açman gerek** (adım 1) |
| Proje sayfasında "Code signing policy": "Free code signing provided by SignPath.io, certificate by SignPath Foundation" satırı, roller, gizlilik açıklaması; ana sayfadan ve indirme sayfasından bağlantı | signpath.org/terms (alıntı) + başvuran projeler | README'nin sonundaki "Code signing policy" (bu dalda; **main'e geçmesi gerek**) |
| Kullanıcının gizliliğini/güvenliğini bozan özellik yok; istenmeyen ağ trafiği açıklanmış | signpath.org/terms (alıntı) | README'deki Privacy maddesi (güncelleme denetimi dahil) |
| İmzalanacak biçimde zaten yayımlanmış olmak | başvuran projelerin aktardığı | 0.8.0 NSIS kurulumu yayımlandı |
| Açık kaynak projede imza isteğine giden her iş **GitHub'ın kendi sunucularında** (GitHub-hosted runner) çalışmalı | docs.signpath.io/trusted-build-systems/github (arama özeti) + başvuran projeler | release.yml yalnız `windows-latest`/`macos-latest`/`ubuntu-latest` kullanıyor |
| Her imza isteği elle onaylanır | başvuran projeler | iş akışı her dosya için onayını bekler (en çok 1 saat) |

---

## Sırayla yapılacaklar

### 1. GitHub hesabında iki aşamalı doğrulama

<https://github.com/settings/security> › **Two-factor authentication** › açık
olmalı (bir doğrulayıcı uygulama ya da passkey). Depoya yazma yetkisi olan
başka biri varsa onda da.

### 2. Bu dalı `main`'e al

README'deki "Lisans" ve "Code signing policy" bölümleri ile `LICENSE` dosyası
GitHub'daki depo ana sayfasında görünmeli; inceleyen kişi oraya bakar. Bu dal
(`feat/v10-license-signing`) `dev`'e, sonra `main`'e geçince görünür. Depo
**herkese açık** olmalı (öyle).

### 3. Başvuru formu

<https://signpath.org/apply>. Formun alanlarını göremedim; başka başvuranların
yazdıklarına göre aşağıdakiler soruluyor. Alan adları farklıysa en yakınına
yapıştır. İngilizce doldur.

| alan | yapıştır |
|---|---|
| Project name | `Trio` |
| Project / homepage URL | `https://github.com/borankaraduman-star/Trio` |
| Repository URL | `https://github.com/borankaraduman-star/Trio` |
| Download URL | `https://github.com/borankaraduman-star/Trio/releases` |
| License | `MIT` |
| Code signing policy URL | `https://github.com/borankaraduman-star/Trio#code-signing-policy` |
| Privacy policy URL | `https://github.com/borankaraduman-star/Trio#code-signing-policy` (Privacy maddesi orada) |
| Build system | `GitHub Actions (GitHub-hosted runners): https://github.com/borankaraduman-star/Trio/blob/main/.github/workflows/release.yml` |
| What will be signed | aşağıdaki metin |
| Description | aşağıdaki metin |
| Reputation / users / downloads | aşağıdaki metin (abartma: GitHub'daki indirme sayılarını yaz) |
| Your role / maintainers | `borankaraduman-star (sole maintainer: committer, reviewer and approver)` |

**Description:**

```text
Trio is a small self-hosted voice and text chat app (a private Discord
alternative): text channels, voice rooms over full-mesh WebRTC, screen and
camera sharing, attachments. The server (Python/FastAPI) runs on the user's
own host; the clients are a web app and an Electron desktop app for Windows,
macOS and Linux that loads the web client from the server address the user
enters. The project is MIT licensed and all of its dependencies are open
source (see THIRD-PARTY-NOTICES.md). The desktop app's extra features are
opt-in and local: a global push-to-talk key (uiohook-napi), an optional game
status (reads the local process list and a World of Warcraft addon's file)
and an optional "now playing" title for shared music. It has no analytics; it
talks only to the user's server and to GitHub Releases for updates.
```

**What will be signed:**

```text
Only our own Windows binaries, built from this repository by
.github/workflows/release.yml on GitHub-hosted runners with electron-builder:
Trio.exe (the Electron app executable), its NSIS uninstaller and the NSIS
installer Trio-<version>-win-x64.exe. Each is submitted with
signpath/github-action-submit-signing-request during the electron-builder run
(three signing requests per release, each approved manually), so the update
metadata (latest.yml, blockmap) is computed from the signed installer.
Third-party binaries in the installer (Electron runtime DLLs, the
uiohook-napi native module, NSIS's elevate.exe) are not submitted.
Releases happen a few times a month at most.
```

**Reputation** (doğru olanı yaz; örnek):

```text
A young project used by a small group of friends; releases and downloads are
on the GitHub releases page. Source, release workflow and dependency licences
are public in the repository.
```

Onay kutuları (aktarılanlara göre): davranış kurallarını kabul, sertifikanın
SignPath Foundation adına olduğunu ve şartlar ihlal edilirse geri
alınabileceğini kabul. Gönder.

### 4. Kabul edilirsen: SignPath'te kurulum

Kabulden sonra SignPath sana bir organizasyon (ve büyük ihtimalle `trio` adlı
bir proje) açar. Hesabına girerken **SignPath'te de MFA'yı aç**. Sonra:

1. **Organizasyon kimliği**: SignPath'te sol menü › organizasyon ayarları; bir
   GUID (`xxxxxxxx-xxxx-…`). Not et.
2. **Proje**: slug'ı not et (ör. `trio`). Projeye **GitHub'ı güvenilir derleme
   sistemi** (Trusted Build System › GitHub.com) olarak bağla; SignPath bunun
   için kendi GitHub uygulamasını depoya kurmanı isteyebilir.
3. **Artifact configuration**: projeye üç tane ekle, slug'ları **aynen** şunlar
   (iş akışı bu adları kullanıyor). Her biri bir GitHub artifact'ını (zip)
   açar ve içindeki tek dosyayı imzalar. Dosya adları sabit; sürüm numarası
   yok.

   `trio-app`:

   ```xml
   <?xml version="1.0" encoding="utf-8"?>
   <artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
     <parameters>
       <parameter name="productVersion" required="true" />
     </parameters>
     <zip-file>
       <pe-file path="Trio.exe" product-name="Trio" product-version="${productVersion}">
         <authenticode-sign />
       </pe-file>
     </zip-file>
   </artifact-configuration>
   ```

   `trio-uninstaller`: aynısı, `path="Trio-uninstaller.exe"`.

   `trio-installer`: aynısı, `path="Trio-setup.exe"`.

   `productVersion`'ı iş akışı dosyanın kendi sürüm bilgisinden okuyup gönderir.
   SignPath Foundation, `authenticode-sign`'a `description` eklenmesini kabul
   etmiyormuş (başka bir projenin notu); ekleme. SignPath bu XML'i farklı bir
   biçimde isterse (ör. kendi şablonunu verirse) şablona uy, yalnız slug'ları ve
   dosya adlarını koru.
4. **İmzalama politikası (signing policy)**: Foundation genelde bir
   `test-signing` ve bir `release-signing` politikası verir. İş akışına
   **`release-signing`**'in slug'ını ver: test sertifikası Windows'ta "Valid"
   sayılmaz ve iş akışı imzayı geçersiz bulup durur (bilerek). Onaylayıcı
   (approver) olarak kendini seç.
5. **API token**: SignPath'te bir CI kullanıcısı (ya da kendi kullanıcın) için
   API token oluştur; bu kullanıcı projede imza isteği gönderebilmeli
   (Submitter). Token'ı bir kez gösterir; kopyala.

### 5. GitHub'a sırları ve değişkenleri gir

Depo › **Settings › Secrets and variables › Actions**.

**Secrets** sekmesi › *New repository secret*:

| ad | değer |
|---|---|
| `SIGNPATH_API_TOKEN` | 4.5'teki token |

**Variables** sekmesi › *New repository variable*:

| ad | değer |
|---|---|
| `SIGNPATH_ORGANIZATION_ID` | 4.1'deki GUID |
| `SIGNPATH_PROJECT_SLUG` | 4.2'deki slug (ör. `trio`) |
| `SIGNPATH_SIGNING_POLICY_SLUG` | 4.4'teki release politikasının slug'ı (ör. `release-signing`) |
| `SIGNPATH_PUBLISHER_NAME` | **gerekirse**: sertifikadaki "CN" adı `SignPath Foundation` değilse onu aynen yaz. Varsayılan `SignPath Foundation`. |

Dördü (token + üç değişken) birden varsa Windows derlemesi SignPath ile
imzalanır; biri eksikse uyarı yazar ve imzasız derler (bugünkü gibi).

### 6. İlk imzalı sürüm: önce bir ön-sürüm (pre-release)

Ön-sürümler kurulu uygulamalara güncelleme olarak **gitmez** (uygulamalar
yalnız `releases/latest`'e bakar), o yüzden ilk denemeyi onunla yap:

```bash
gh workflow run release.yml --ref main -f version=0.9.0-rc.1 -f ref=main
```

Windows işi sırayla üç imza isteği açar: `Trio.exe`, kaldırıcı, kurulum
dosyası. Her biri için SignPath sana e-posta/bildirim gönderir; SignPath'te
isteği aç, **Approve**. İş her onayı en çok 1 saat bekler; iş toplam 4 saatte
zaman aşımına uğrar. İş akışının günlüğünde her isteğin SignPath bağlantısı
yazar.

İş akışı şunları kendisi denetler, biri tutmazsa durur ve yayımlamaz:
imzanın Windows'a göre geçerli olması, sertifikadaki adın
`SIGNPATH_PUBLISHER_NAME` olması, `latest.yml`'deki sha512'nin imzalı kurulum
dosyasınınki olması.

### 7. Elle doğrula

1. Ön-sürümün `signing.json` dosyası `"windows": true` demeli.
2. Bir Windows bilgisayarda `Trio-0.9.0-rc.1-win-x64.exe`'yi indir › sağ tık ›
   **Özellikler › Dijital İmzalar**: "SignPath Foundation", **Ayrıntılar** ›
   "Bu dijital imza geçerli". PowerShell'de:

   ```powershell
   Get-AuthenticodeSignature .\Trio-0.9.0-rc.1-win-x64.exe | Format-List Status, SignerCertificate
   ```

3. Çift tıkla: SmartScreen uyarısı çıkıyor mu, çıkıyorsa yayımcı ne yazıyor?
   Not al (itibar zamanla oluşur).
4. Kurulu `Trio.exe` de imzalı olmalı
   (`%LOCALAPPDATA%\Programs\Trio\Trio.exe`, aynı Özellikler sekmesi).
5. Her şey doğruysa gerçek sürümü çıkar (`-f version=0.9.0`). O zaman kurulu
   0.8.x uygulamaları kendiliğinden günceller (aşağıda neden).

İmza tuttuktan sonra `/indir` sayfası Windows için uyarı yardımını kendiliğinden
kısaltır (`signing.json`). Foundation'ın şartı gereği indirme sayfasında
"Free code signing provided by SignPath.io, certificate by SignPath Foundation"
satırı ve politikaya bağlantı da olmalı; bu, ilk imzalı sürümden sonra
`/indir`'e eklenecek (şimdi eklenmedi, çünkü henüz doğru değil).

---

## Güncellemeler ve imza: bilmen gerekenler

Ayrıntı `CONTRACT-V10-UPDATE.md` §9'da. Kısaca:

- **İmzasız 0.8.x → ilk imzalı sürüm: sorunsuz.** Kurulu uygulama yayımcı
  denetimini, kendi `app-update.yml` dosyasında `publisherName` varsa yapar;
  imzasız sürümlerde yok. Yeni (imzalı) sürüm kurulunca bu dosyaya
  `publisherName: SignPath Foundation` yazılır.
- **İmzalı → imzalı:** her güncellemede yeni kurulum dosyasının "SignPath
  Foundation" tarafından imzalandığı denetlenir. Bu ek bir güvence: GitHub
  hesabı ele geçse bile imzasız bir dosya güncelleme olarak kurulmaz.
- **İmzalı bir sürümden sonra imzasız sürüm çıkarma.** Kurulu uygulamalar onu
  **reddeder** (güncelleme hatası verir, eski sürümde kalır). Bu yüzden iş
  akışı, son sürüm Windows'ta imzalıysa ve SignPath ayarları yoksa **durur**.
  Bilerek imzasız çıkarmak gerekirse (ör. SignPath kapandı) depo değişkeni
  `TRIO_ALLOW_UNSIGNED_WINDOWS` = `true` yap; o sürümü herkes `/indir`'den bir
  kez **elle** kurmak zorunda kalır.
- **Yayımcı değişirse** (SignPath'ten kendi sertifikana geçmek, ya da
  sertifikadaki adın değişmesi): aynı durum; kurulu uygulamalar yeni yayımcının
  dosyasını reddeder, herkes bir kez elle kurar. Sertifikanın yenilenmesi (aynı
  "SignPath Foundation" adıyla) sorun değil: denetim yalnız adı karşılaştırır.
- **SignPath'in GitHub Action'ı veya SignPath hizmeti çalışmıyorsa** sürüm
  çıkmaz (iş akışı durur). Bekle ve tekrar dene.

## Sınırlar

- İmza yalnız Windows için. macOS uyarısı Apple Developer ID ile kalkar
  (`docs/imzalama.md`), Linux AppImage için imza gerekmez.
- Her sürümde üç onay gerekir (aktarılan aylık kota 3000 imza; sorun değil).
- Bu iş akışı gerçek SignPath'e karşı hiç çalışmadı. Yerelde, SignPath'i taklit
  eden testlerle ve electron-builder'ın gerçek Windows derlemesinin ilk
  adımlarıyla denendi; arka planda çalışan derlemenin GitHub'ın Windows
  sunucusunda adımlar arasında yaşadığı başka bir projenin (aynı yöntemi
  kullanan HackDesk) başarılı test imzalamasından biliniyor, Trio'da
  denenmedi. İlk ön-sürüm bunu sınar.

## Kaynaklar

- signpath.org/terms — "SignPath Foundation conditions for Open Source
  projects" (arama sonucu alıntıları: OSI lisansı, çift lisans yok, sertifika
  SignPath Foundation adına, roller, MFA, gizlilik, "Free code signing provided
  by SignPath.io, certificate by SignPath Foundation")
- docs.signpath.io/trusted-build-systems/github (arama özeti: artifact
  önce GitHub artifact'ı olarak yüklenir, `required_github_hosted`)
- github.com/SignPath/github-action-submit-signing-request — `action.yml`
  (girdiler: `api-token`, `organization-id`, `project-slug`,
  `signing-policy-slug`, `artifact-configuration-slug`, `github-artifact-id`,
  `wait-for-completion`, `output-artifact-directory`, `parameters`; son sürüm
  v3, node24) — birinci elden okundu
- SignPath kullanan projelerin belgeleri (ikinci elden, örnek olarak):
  EastSun5566/hackdesk (`docs/code-signing-policy.md`,
  `scripts/signpath-bridge.cjs`, `build/signpath/*.xml`: Electron + NSIS, aynı
  arka plan derleme yöntemi), metasequoiaime/msime-windows
  (`docs/code-signing-policy.md`, `installer/signpath/*.xml`),
  kapitalismho/PuriPuly-heart (`CODE_SIGNING.md`), katariyaVivek/chaya
  (README), sebbourgeois/promptbox (`docs/SIGNPATH.md`)
- Başvuru süresi ve ret anekdotları: başka projelerin GitHub issue'ları
  (Source191/cader #263, getdictus/dictus-desktop #38 ve benzerleri)
- electron-updater 6.8.11 kaynağı: `NsisUpdater.verifySignature`,
  `windowsExecutableCodeSignatureVerifier.js`; app-builder-lib 26.18:
  `PublishManager` (publisherName → app-update.yml), `NsisTarget`/`nsisUtil`
  (imzalama sırası) — birinci elden okundu
