# Trio'nun yedeği: almak, kontrol etmek, geri yüklemek

Bu sayfa sunucunun sahibi içindir (Ayarlar'da **Yönetim** bölümünü gören kişi).
Ayrıntılı kurallar `CONTRACT-V6-OPS.md` §3'te.

## Yedekte ne var

Tek bir `.tar` dosyası:

- `trio.db` — veritabanının tutarlı bir kopyası: herkes, bütün kanallar ve mesajlar,
  tepkiler, sabitlemeler, profil bilgileri, hata kayıtları;
- `uploads/` — yüklenen bütün dosyalar, profil resimleri ve sunucu simgesi;
- `manifest.json` — yedeğin ne zaman alındığı, kaç mesaj/dosya olduğu ve veritabanı
  kopyasının parmak izi (sha256).

**Oturum anahtarlarının özetleri yedekte durur.** Böylece geri yüklenen sunucuda kimse
yeniden giriş yapmak zorunda kalmaz. Bunun bedeli: bu dosyayı ele geçiren biri,
sunucunun diskini ele geçirmiş gibidir. Dosyayı herkese açık bir yere koyma; telefonunda
ya da kendi bulut hesabında sakla. Cihaz kodları ve deneme sınırları yedeğe girmez.

## 1. Yedeği indir

1. Trio'da **Ayarlar › Yönetim › Yedek › Yedeği indir**'e dokun.
2. Tarayıcı dosyayı normal bir indirme olarak indirir (`trio-yedek-2026-11-19-1420.tar`
   gibi). İlerlemeyi hem tarayıcının indirme çubuğu hem de Trio'daki çubuk gösterir.
3. İndirme bitince kartta “Yedek indirildi” ve “Son yedek: az önce · 14.203 mesaj, 312 dosya”
   gibi bir satır görürsün.

Son yedek 14 günden eskiyse (ya da hiç yoksa) ayarlar düğmesinde (telefonda menü
düğmesinde) kırmızı bir nokta çıkar.

Yedek alınırken herkes kullanmaya devam edebilir; görüşmeler kesilmez. Aynı anda yalnızca
bir yedek indirilebilir.

## 2. Yedeği kontrol et (isteğe bağlı ama önerilir)

Bilgisayarında, depo içinde (`server/` klasöründe sanal ortam kuruluysa):

```bash
cd server
.venv/bin/python -m trio_server.backup verify ~/Downloads/trio-yedek-2026-11-19-1420.tar
```

Çıktı şöyle biter:

```
backup of 2026-11-19T14:20:03.512Z (server 0.4.0): 3 users, 4 channels, 14203 messages, 311 attachments (…) 312 files
ok: integrity_check passed and the counts match the manifest
```

`problem:` ile başlayan bir satır varsa dosya bozulmuş ya da eksik inmiştir; yeni bir
yedek indir.

## 3. Geri yükle (yeni bir Railway volume'üne)

Ne zaman: volume silindi/bozuldu, sunucuyu başka bir projeye taşıyorsun.

1. **Railway'de yeni bir volume oluştur** ve Trio servisine `/data` yoluna bağla
   (Service › Settings › Volumes). Servis açılınca boş bir `trio.db` ve `uploads/`
   oluşturur; sorun değil, birazdan kenara alınacaklar.
2. **Yedeği sunucuya taşı.** Railway CLI'yi kurduğun bir bilgisayarda, projenin
   klasöründe:

   ```bash
   railway link                       # projeyi ve Trio servisini seç
   railway ssh -- python -m trio_server.backup restore - --data-dir /data --force \
       < trio-yedek-2026-11-19-1420.tar
   ```

   `-` dosyayı standart girdiden okur. `--force`, `/data` içinde ne varsa (servisin az
   önce oluşturduğu boş veritabanı) silmez, `/data/before-restore-<zaman>/` klasörüne
   taşır. Komut önce yedeği kontrol eder; kontrol geçmezse hiçbir şey yazmaz.

   `railway ssh` girdiyi aktaramazsa: yedeği geçici, sadece senin bildiğin bir bağlantıya
   koy ve konteynerin içinde indir:

   ```bash
   railway ssh
   python -c "import urllib.request,sys; urllib.request.urlretrieve(sys.argv[1], '/data/yedek.tar')" 'https://…'
   python -m trio_server.backup restore /data/yedek.tar --data-dir /data --force
   rm /data/yedek.tar
   ```

3. Çıktının son satırı `restored into /data; restart the server now` olmalı.
4. **Servisi yeniden başlat** (Railway › Deployments › Restart). Açılırken veritabanını ve
   dosyaları yükler.
5. Kontrol: Trio'yu aç. Herkes oturumu açık hâlde içeride olmalı, eski mesajlar ve dosyalar
   yerinde. Her şey yolundaysa `before-restore-…` klasörünü silebilirsin:

   ```bash
   railway ssh -- rm -rf /data/before-restore-20261119-142500
   ```

Volume'ün yolu `/data` değilse (`TRIO_DB_PATH`, `TRIO_UPLOAD_DIR` değişkenleri),
`--data-dir` o klasör olmalı ve veritabanı `trio.db`, dosyalar `uploads/` adıyla yazılır;
değişkenleri buna göre ayarla.

## Bilinmeyenler

- Çok büyük bir yedeğin (birkaç GB) Railway'in kenar sunucusundan uzun süren bir indirme
  olarak sorunsuz geçtiği gerçek bir sunucuda denenmedi.
- `railway ssh` ile standart girdi aktarımı ve geri yüklemenin gerçek bir Railway
  volume'ünde çalışması denenmedi; testler yalnızca boş bir klasöre geri yükleyip
  sunucuyu onunla açıyor.
