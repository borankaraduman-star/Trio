# Trio

Üç beş arkadaş için kendi barındırdığın küçük bir Discord alternatifi: yazı kanalları, dosya paylaşımı, sesli odalar, kamera ve ekran paylaşımı. Tarayıcıdan ya da masaüstü uygulamasından kullanılır. Önerilen kurulum **Railway** (tek servis, tek volume); kendi VPS'inde çalıştırmak isteyenler için Docker Compose + coturn seçeneği de var.

## Özellikler

- Yazı kanalları: kalıcı geçmiş, yukarı doğru sonsuz kaydırma, "yazıyor" satırı, okunmamış işareti, tıklanabilir bağlantılar
- **Dosya ekleri**: ataç düğmesi, panodan yapıştırma, sürükle-bırak; görseller mesajın içinde (tıklayınca büyür), video/ses oynatıcıyla, diğer dosyalar indirilebilir satır olarak. Varsayılan sınır dosya başına 25 MB, mesaj başına 10 dosya
- Sesli odalar: sustur, sağırlaştır, konuşan kişi göstergesi
- **Kamera** ve ekran paylaşımı (sesiyle), tam ekran izleme
- **Bas-konuş (push-to-talk)**, tuşu ayarlardan seçilir; masaüstü uygulamasında pencere odakta değilken de çalışır
- **Gürültü bastırma** (RNNoise), ayarlardan açılıp kapanır
- Mikrofon / hoparlör / kamera seçimi (ayarlar penceresi)
- **Masaüstü uygulaması** (Windows, macOS, Linux; `desktop/`): sistem tepsisi, okunmamış rozeti, global bas-konuş tuşu
- Hesap yok, e-posta yok: ad + ortak davet kodu. Arayüz Türkçe

## Mimari

```
tarayıcı / masaüstü ──HTTPS/WSS──> Railway kenarı ──> app (FastAPI + SQLite, tek süreç)
tarayıcı <──── WebRTC (ses / kamera / ekran), doğrudan ya da Cloudflare TURN üzerinden ────> tarayıcı
```

- **app**: tek konteyner (kökteki `Dockerfile`). `/api/*` (REST), `/ws` (mesajlar, çevrimiçi durumu, WebRTC sinyalleşmesi) ve derlenmiş web istemcisini sunar. Veri: tek bir SQLite dosyası + yüklenen dosyalar, ikisi de `/data` volume'unda.
- **TURN**: iki kişi birbirine doğrudan ulaşamadığında (simetrik NAT, mobil şebeke) medyayı aktarır. Railway'de UDP olmadığı için TURN, Cloudflare'in ücretsiz TURN hizmetinden gelir; sunucu kısa ömürlü kimlik bilgilerini Cloudflare'den alıp istemciye verir.
- Sesli oda **tam ağ (mesh)**: herkes herkese doğrudan bağlanır, sunucu medyaya dokunmaz. 3 kişi için idealdir; seste 5–6 kişiye kadar rahat, kamera/ekran açıkken sınır daha erken gelir.
- Uygulama **tek süreç** çalışır (durum bellekte). Birden fazla worker ya da replika çalıştırma.

Sözleşmeler: [`CONTRACT.md`](CONTRACT.md), [`CONTRACT-V2.md`](CONTRACT-V2.md).

## Railway'e kurulum (önerilen)

**1. Proje.** Bu depoyu GitHub'a koy. Railway'de **New Project → Deploy from GitHub repo** ile depoyu seç. Railway kökteki `Dockerfile`'ı kendisi bulur ve imajı (web + sunucu) derler. `railway.json` yok ve gerekmiyor; ayarların hepsi panelden yapılır.

**2. Volume.** Servisin üzerinde sağ tık (ya da `Ctrl/⌘+K` → *Add Volume*) → **Volume ekle**, bağlama yolu (mount path) **`/data`**. Veritabanı `/data/trio.db`, yüklenen dosyalar `/data/uploads` altında durur; imaj bu yolları zaten varsayılan olarak kullanır. Volume olmazsa her deploy'da tüm veri silinir.

> Railway volume'u root kullanıcısına ait bağlar. İmaj bu yüzden **root olarak çalışır**; `RAILWAY_RUN_UID=0` ayarlamana gerek yoktur.

**3. Değişkenler.** Servis → **Variables**:

- `TRIO_INVITE_CODE` (zorunlu): arkadaşlarına vereceğin kod, ör. `openssl rand -hex 8`
- `TRIO_CF_TURN_KEY_ID` ve `TRIO_CF_TURN_API_TOKEN`: Cloudflare TURN (aşağıya bak). Olmadan da çalışır, ama farklı ağlardaki kişiler birbirini duyamayabilir.
- İsteğe bağlı: `TRIO_MAX_USERS`, `TRIO_MAX_UPLOAD_MB` (tablo aşağıda)

`PORT`'u Railway kendisi verir, sunucu onu dinler; elle ayarlama.

**Cloudflare TURN anahtarı.** Ücretsiz bir Cloudflare hesabıyla: panelde **Realtime → TURN Server** bölümüne gir, **Create** ile yeni bir TURN anahtarı oluştur, bir ad ver. Gösterilen **Turn Token ID** değerini `TRIO_CF_TURN_KEY_ID`'ye, **API Token** değerini `TRIO_CF_TURN_API_TOKEN`'a yaz. API token yalnızca bir kez gösterilir; kaybedersen yeni anahtar oluştur. (Panelde menü adları zaman zaman değişiyor; eski adı "Calls".)

**4. Sağlık kontrolü.** Servis → **Settings → Deploy → Healthcheck Path**: **`/api/health`**. Railway yeni sürümü bu adres 200 dönünce devreye alır.

**5. Alan adı.** Servis → **Settings → Networking → Generate Domain**. `https://<ad>.up.railway.app` gibi bir adres çıkar (port sorulursa: Railway'in verdiği `PORT`, yani panelin önerdiği değer). İstersen burada kendi alan adını da bağlayabilirsin. HTTPS'i Railway sağlar.

**6. Dene.** Adresi aç, ad + davet kodu ile gir. Mikrofon izni ver, sesli odaya katıl.

**Güncelleme:** GitHub'a push et; Railway yeniden derler ve deploy eder. Veriler volume'da kalır. Deploy sırasında birkaç saniyelik kesinti olur (volume'lu servis tek kopya çalışır); istemciler kendiliğinden yeniden bağlanır, sesli odadakiler odaya geri girer.

## Arkadaşlar nasıl katılır

- **Tarayıcı:** Railway adresini açarlar, bir **ad** ve **davet kodunu** yazarlar. Oturum tarayıcıda saklanır. Telefonda da çalışır.
- **Masaüstü uygulaması:** `desktop/` içindeki uygulamayı kurarlar (GitHub Releases'teki Windows/macOS/Linux paketleri). İlk açılışta sunucu adresi sorulur: `https://<ad>.up.railway.app`. Sonra aynı giriş ekranı gelir. Paketler imzasız olduğu için Windows SmartScreen ve macOS Gatekeeper uyarı verir (ayrıntı `desktop/` içinde).

Kod sızarsa Railway'de `TRIO_INVITE_CODE`'u değiştir (servis yeniden başlar); mevcut oturumlar etkilenmez, yeni katılımlar yeni kodu ister. `TRIO_MAX_USERS` hesap sayısını sınırlar.

## Ortam değişkenleri

| değişken | varsayılan | anlamı |
|---|---|---|
| `TRIO_INVITE_CODE` | (zorunlu) | ortak davet kodu; yoksa sunucu başlamaz |
| `TRIO_MAX_USERS` | `10` | bu sayıdan sonra yeni katılım reddedilir |
| `TRIO_MAX_UPLOAD_MB` | `25` | dosya başına en büyük boyut (MB) |
| `TRIO_CF_TURN_KEY_ID` | boş | Cloudflare TURN anahtarının "Turn Token ID"si |
| `TRIO_CF_TURN_API_TOKEN` | boş | Cloudflare TURN anahtarının API token'ı (gizli) |
| `TRIO_TURN_HOST` | boş | kendi coturn sunucunun adı (VPS kurulumu; Cloudflare ayarlıysa kullanılmaz) |
| `TRIO_TURN_SECRET` | boş | coturn `static-auth-secret` (VPS kurulumu) |
| `TRIO_STUN_URLS` | `stun:stun.l.google.com:19302` | virgülle ayrılmış STUN adresleri |
| `TRIO_DB_PATH` | imajda `/data/trio.db` | SQLite dosyası |
| `TRIO_UPLOAD_DIR` | imajda `/data/uploads` | yüklenen dosyaların klasörü |
| `TRIO_STATIC_DIR` | imajda `/app/static` | derlenmiş web istemcisi |
| `PORT` | `8000` | dinlenen port; Railway kendisi verir |

TURN önceliği: Cloudflare (iki değişken de doluysa) → coturn (`TRIO_TURN_HOST` + `TRIO_TURN_SECRET`) → yalnızca STUN. Cloudflare'e ulaşılamazsa `/api/ice` hata vermez, yalnızca STUN döner ve sunucu günlüğüne bir uyarı yazar (token asla yazılmaz). Cloudflare'in yanıtı 1 saat önbellekte tutulur.

## Yedekleme

Her şey volume'da: `/data/trio.db` (SQLite) ve `/data/uploads/` (dosyalar, adları rastgele kimlikler).

- **Railway yedekleri:** volume'un **Backups** sekmesinden elle ya da zamanlanmış yedek alınabilir (planına bağlı) ve geri yüklenebilir. En kolay yol budur.
- **Elle kopya:** Railway CLI ile servise bağlanıp (`railway ssh`) tutarlı bir veritabanı kopyası al:

  ```bash
  python -c "import sqlite3; s=sqlite3.connect('/data/trio.db'); d=sqlite3.connect('/data/yedek.db'); s.backup(d); d.close()"
  tar czf /data/yedek.tgz -C /data yedek.db uploads
  ```

  Ardından dosyayı makinene al (ör. `railway ssh` oturumunda `base64 /data/yedek.tgz` çıktısını kopyalayarak ya da kendi yönteminle) ve işin bitince `/data/yedek.*` dosyalarını sil.

Geri yüklemede `trio.db` ile `uploads/` birlikte geri konmalı; birinin eski diğerinin yeni olması, mesajlarda kırık eklere yol açar.

## Alternatif: kendi VPS'in (Docker Compose + coturn)

Railway yerine tek bir Linux sunucuda (1 vCPU / 1 GB yeter) çalıştırmak için `deploy/` klasörü: Caddy (otomatik HTTPS), app (aynı kök `Dockerfile`) ve coturn (kendi TURN sunucun).

1. Alan adı için sunucunun IPv4'üne bir **A kaydı** aç.
2. Docker kur: `curl -fsSL https://get.docker.com | sudo sh`
3. Güvenlik duvarında aç: 80/443 tcp (443/udp isteğe bağlı), 3478 tcp+udp, 49160–49200 udp. Sağlayıcının kendi güvenlik duvarında da.
4. `cd deploy && cp .env.example .env`, değerleri doldur (`TRIO_DOMAIN`, `TRIO_PUBLIC_IP`, `TRIO_INVITE_CODE`, `TRIO_TURN_SECRET`; NAT arkasındaki sunucuda `TRIO_PUBLIC_IP=GENEL/ÖZEL`).
5. `sudo docker compose up -d --build`, sonra `sudo docker compose ps` (app `healthy` olmalı).

Güncelleme: `git pull && sudo docker compose up -d --build`. Yedek: `sudo docker compose exec app python -c "..."` ile yukarıdaki SQLite kopyası, artı `/data/uploads`. coturn'ün TLS'siz çalıştığı ve `turns:` adresinin bu yüzden başarısız olmasının beklendiği `deploy/turnserver.conf` içinde açıklanıyor. VPS'te de Cloudflare TURN kullanmak istersen `.env`'e iki `TRIO_CF_*` değişkenini yazman yeter; coturn'ün önüne geçer.

## Yerelde geliştirme

Python 3.12+, [uv](https://docs.astral.sh/uv/), Node 22.

```bash
cd server && uv venv && uv pip install -e '.[dev]'
TRIO_INVITE_CODE=gizli .venv/bin/uvicorn trio_server.main:app --reload --port 8000
.venv/bin/python -m pytest -q && .venv/bin/ruff check .

cd web && npm install && npm run dev      # http://localhost:5173, /api ve /ws :8000'e gider
```

`localhost` güvenli bağlam sayıldığı için mikrofon HTTPS olmadan çalışır; ağdaki başka bir cihazdan IP ile açarsan çalışmaz. İmajı yerelde denemek: `docker build -t trio . && docker run -p 8000:8000 -e TRIO_INVITE_CODE=gizli -v trio_data:/data trio`.

## Sorun giderme

**"Ses yok" / bağlanıyor ama duyulmuyor**

1. Adres `https://` mi? Tarayıcılar mikrofon, kamera ve ekran paylaşımına yalnızca HTTPS'te (ve `localhost`'ta) izin verir. Railway adresi zaten HTTPS'tir.
2. Site için mikrofon izni verilmiş mi (adres çubuğundaki kilit simgesi)? macOS'ta *Sistem Ayarları → Gizlilik → Mikrofon/Kamera* içinde tarayıcıya (ya da Trio uygulamasına) izin var mı?
3. Ayarlar penceresinde doğru mikrofon ve hoparlör seçili mi? Giriş modu **bas-konuş** ise tuşa basmadan ses gitmez. Kişi kendini susturmuş/sağırlaştırmış olabilir.
4. Gürültü bastırmayı kapatıp dene (çok nadiren bazı mikrofonlarda sesi fazla keser).
5. Aynı evdekiler birbirini duyuyor ama dışarıdaki duymuyorsa sorun TURN'dedir:
   - Railway'de `TRIO_CF_TURN_KEY_ID` ve `TRIO_CF_TURN_API_TOKEN` dolu mu? Railway günlüğünde `ice.cloudflare.failed` uyarısı var mı (yanında HTTP durumu yazar; `401` = token yanlış)?
   - Giriş yapmışken tarayıcı konsolunda:

     ```js
     fetch('/api/ice', {headers: {Authorization: 'Bearer ' + localStorage.getItem('trio.token')}}).then(r => r.json()).then(console.log)
     ```

     Listede `turn:turn.cloudflare.com...` adresleri ve `username`/`credential` olmalı. Bu değerleri <https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/> sayfasında dene; **`relay`** türünde aday görmelisin.
6. `chrome://webrtc-internals` (Firefox: `about:webrtc`) seçilen aday çiftini ve paket sayaçlarını gösterir.

**Dosya yüklenmiyor.** "çok büyük" hatası `TRIO_MAX_UPLOAD_MB` sınırıdır. Railway'de volume `/data`'ya bağlı değilse dosyalar bir sonraki deploy'da kaybolur. 24 saat içinde bir mesaja eklenmeyen yüklemeler otomatik silinir.

**Sayfa açılıyor ama "bağlantı koptu".** Railway → Deployments → günlükler. `TRIO_INVITE_CODE` boşsa sunucu başlamaz. Sağlık kontrolü yolu `/api/health` olmalı.

**"Çok fazla deneme" (429).** Katılma denemeleri adres başına 10 dakikada 10 ile sınırlı; bekle.

## Bilinen sınırlar

- Mesh nedeniyle sesli odada pratik sınır 5–6 kişi; kamera ve ekran paylaşımı açıkken daha az.
- Tek süreç, tek kopya; yatay ölçekleme yok. Deploy ya da yeniden başlatmada herkes kısa süre düşer ve yeniden bağlanır.
- Roller, moderasyon, mesaj düzenleme/silme, özel mesaj yok. Davet kodunu bilen herkes eşit üyedir.
- Oturum belirteçlerinin süresi dolmaz; uzaktan çıkış yaptırma arayüzü yok.
- Mesajlar ve dosyalar sunucuda şifresiz durur. Dosya bağlantıları gizli kimlik içerir; bağlantıyı bilen herkes dosyayı açabilir, bu yüzden bağlantıları dışarı paylaşma. Ses, kamera ve ekran tarayıcılar arasında uçtan uca şifrelidir.
- iOS Safari'de ekran paylaşımı yok (tarayıcı desteklemiyor); izlemek mümkün.
