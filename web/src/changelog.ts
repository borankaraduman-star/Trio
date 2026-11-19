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
    title: 'Mesajlar',
    lines: [
      'Mesajlara tepki: üstüne gel ya da telefonda basılı tut, bir emoji seç; kimin verdiğini üzerine gelince görürsün.',
      'Yanıtla: alıntı yanıtın üstünde durur, tıklayınca asıl mesaja gider. Önemli mesajları sabitle; başlıktaki Sabitlenenler hepsini gösterir.',
      'Kendi mesajını yerinde düzenle (boş yazı kutusunda ↑ son mesajını açar) ya da sil; düzenlenen mesajda “(düzenlendi)” yazar.',
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
