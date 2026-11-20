# Trio'nun adresini değiştirmek

Ayrıntılı kurallar: `CONTRACT-V11-ADDRESS.md`. Burada iki yol var; hangisi
sana uyuyorsa onu izle.

## A. Railway adresini yeniden adlandırmak (eski adres anında ölür)

Örnek: `trio-production-8a183220.up.railway.app` → `triosohbet.up.railway.app`.
Railway'de alan adını değiştirdiğin AN eski adres çalışmaz; iki adres hiçbir
zaman birlikte açık olmaz. Bu yüzden hazırlık ÖNCEDEN yapılır.

1. **Bu sürümü yayınla** (Trio 0.10 ya da sonrası; Yönetim'de “Adres” kartı görünüyorsa tamam).
2. **Railway › Trio servisi › Variables:**
   - `TRIO_RECOVERY_CODE` = uzun, rastgele bir değer (en az 24 karakter; harf ve
     rakam yeter, büyük/küçük harf ve tire önemsiz). Bir yere yaz: bütün
     cihazların giderse onunla girersin.
   - `TRIO_NEXT_URL` = yeni adres, ör. `https://triosohbet.up.railway.app`
     (yalnızca adres, sonunda yol yok). Henüz çalışması gerekmez.

   Sunucu yeniden başlar. Açık olan herkese “Trio’nun adresi yakında
   değişecek” yazısı çıkar:
   - **Masaüstü uygulaması** (yeni sürüm) taşınma kodunu kendisi saklar; adres
     değişince yeni adrese kendisi geçer, kişi yalnızca “Devam et”e basar.
   - **Tarayıcı ve telefon:** “Taşınma kodunu göster” → kodu/bağlantıyı bir yere
     not alırlar (7 gün geçerli).
3. **Bekle:** bir gün ya da Yönetim › Adres'te “N/N oturum taşınma kodunu aldı”
   herkesi gösterene kadar. (Gerekmez ama ne kadar çok kişi hazırsa sonra o kadar
   az kod dağıtırsın.)
4. **Railway › Settings › Networking:** alan adını yeni adla değiştir.
   Bu andan sonra eski adres ölüdür.
5. **Yeni adresi telefonundan aç** (`https://triosohbet.up.railway.app`).
   Girişin yoksa: “Zaten hesabım var” › `TRIO_RECOVERY_CODE` değerini yaz →
   sahibi olarak girersin (ekranın üstünde sarı bir hatırlatma çıkar).
6. **Kalanlara kod dağıt:** Ayarlar › Yönetim › Adres › “Herkese giriş kodu
   üret” (davet koduyla onaylanır). Her kişi için 24 saat geçerli, tek
   kullanımlık bir kod ve bağlantı çıkar. Her birine KENDİ satırını özelden
   gönder (WhatsApp vb.). Bağlantıyı açan doğrudan “Giriş yap”a basar.
   Taşınma kodunu not alan kişi kendi bağlantısını açar. Bekleyen kodları
   “Bekleyen kodları iptal et” ile istediğin an iptal edebilirsin.
7. **Railway › Variables:** `TRIO_PUBLIC_URL` = yeni adres; `TRIO_NEXT_URL` ve
   `TRIO_RECOVERY_CODE`'u **sil**. (Sarı hatırlatma kaybolur.)

### Eski adresle birlikte ölenler

- Eski davet bağlantıları ve cihaz QR'ları eski adrese gider: yenilerini paylaş.
- Bildirimler: her cihaz yeni adreste bildirim iznini bir kez daha verir
  (Ayarlar › Bildirimler).
- Ana ekrana eklenmiş Trio (telefon) eski adresi açar: silip yeni adresten
  yeniden ekle.
- Eski masaüstü uygulaması (0.10 öncesi): Trio menüsü › Sunucuyu değiştir… ›
  yeni adres, sonra sana gönderilen kodla “Zaten hesabım var”.

Masaüstü uygulaması eski adrese ulaşamadığında artık boş pencere göstermez:
“Sunucuya ulaşılamıyor — adres değişmiş olabilir” der, önceden duyurulan yeni
adresi bir düğme olarak sunar ve yeni adresi yazacak bir alan verir.

## B. Kendi alan adını eklemek (eski adres de çalışmaya devam eder)

1. Railway'de servise özel alan adını ekle, sertifika hazır olana ve yeni
   adres Trio'yu açana kadar bekle.
2. **Ancak bundan sonra** `TRIO_PUBLIC_URL` = yeni adres.
3. Eski adresten açan herkes “Trio yeni adrese taşındı — Bu cihazı taşı”
   bandını görür; tek dokunuş, ayarları ve taslakları da gelir, eski adresteki
   oturum kapanır.
4. Yönetim › Adres “eski adresi bırakmak güvenli” dediğinde eski adres
   kaldırılabilir.

Not: `TRIO_PUBLIC_URL`, `TRIO_NEXT_URL` ya da `TRIO_RECOVERY_CODE` yanlış
yazılırsa sunucu başlamaz ve Railway'in günlüğünde nedenini yazar: değişkeni
düzelt ya da sil.
