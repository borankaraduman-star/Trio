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
  lines: string[]
}

export const CHANGELOG: readonly ChangelogEntry[] = [
  {
    version: '0.3.0',
    lines: [
      'Profil fotoğrafı ve ad: Ayarlar › Hesap’tan değiştir; eski mesajlarında da yenisi görünür.',
      'Sunucunun adı ve simgesi Ayarlar › Sunucu’dan değişiyor; Ayarların altında sürüm yazıyor.',
      'Mesajlara tepki: üstüne gel ya da telefonda basılı tut, bir emoji seç; kimin verdiğini üzerine gelince görürsün.',
      'Yanıtla: alıntı yanıtın üstünde durur, tıklayınca asıl mesaja gider. Önemli mesajları sabitle; başlıktaki Sabitlenenler hepsini gösterir.',
      'Kendi mesajını yerinde düzenle (boş yazı kutusunda ↑ son mesajını açar) ya da sil; düzenlenen mesajda “(düzenlendi)” yazar.',
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
