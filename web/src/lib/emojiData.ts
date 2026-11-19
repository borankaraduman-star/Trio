/**
 * The picker's built-in set: about 80 common emoji in a few groups, each with
 * Turkish keywords for the search box. Every entry is written fully
 * qualified (see emojiKey.ts; a unit test holds that).
 */
export interface EmojiEntry {
  emoji: string
  /** Turkish words, lower case, searched by prefix. */
  words: string
}

export interface EmojiGroup {
  id: string
  label: string
  items: EmojiEntry[]
}

const e = (emoji: string, words: string): EmojiEntry => ({ emoji, words })

export const EMOJI_GROUPS: EmojiGroup[] = [
  {
    id: 'faces',
    label: 'Yüzler',
    items: [
      e('😀', 'gülen mutlu sırıtan'),
      e('😄', 'gülen mutlu neşeli'),
      e('😂', 'gülmekten ağlayan kahkaha komik'),
      e('🤣', 'yerlere yatmak kahkaha komik'),
      e('😊', 'gülümseyen utangaç mutlu'),
      e('🙂', 'hafif gülümseyen'),
      e('😉', 'göz kırpan'),
      e('😍', 'kalp gözlü aşık bayıldım'),
      e('🥰', 'sevgi kalpli aşık'),
      e('😘', 'öpücük'),
      e('😎', 'havalı güneş gözlüğü'),
      e('🤔', 'düşünen hmm'),
      e('🙄', 'göz deviren sıkıldım'),
      e('😏', 'sırıtan alaycı'),
      e('😐', 'ifadesiz nötr'),
      e('😅', 'terli gülen utandım'),
      e('😬', 'dişlerini sıkan gergin'),
      e('😮', 'şaşkın ağzı açık'),
      e('😱', 'çığlık korku şok'),
      e('😢', 'ağlayan üzgün'),
      e('😭', 'hüngür hüngür ağlayan üzgün'),
      e('😡', 'kızgın öfkeli sinirli'),
      e('🥲', 'gülümseyerek ağlayan'),
      e('🥳', 'parti kutlama doğum günü'),
      e('😴', 'uyuyan uykulu'),
      e('🤯', 'beyni yanmış şok'),
      e('🫡', 'selam asker tamam'),
      e('🤗', 'sarılan kucak'),
      e('🤐', 'ağzı fermuarlı sus'),
      e('🤢', 'mide bulantısı iğrenç'),
    ],
  },
  {
    id: 'hands',
    label: 'Eller',
    items: [
      e('👍', 'beğen tamam evet olur başparmak'),
      e('👎', 'beğenmedim hayır olmaz'),
      e('👏', 'alkış bravo tebrik'),
      e('🙌', 'eller havada yaşasın'),
      e('🙏', 'lütfen teşekkür rica dua'),
      e('👋', 'merhaba selam el sallama hoşça kal'),
      e('🤝', 'el sıkışma anlaştık'),
      e('✌️', 'zafer barış iki'),
      e('🤞', 'şans parmak çapraz umarım'),
      e('👌', 'tamam süper harika'),
      e('💪', 'güç kas güçlü'),
      e('🫶', 'kalp eller sevgi'),
      e('👀', 'gözler bakıyorum bakalım'),
      e('🤷', 'omuz silken bilmem'),
      e('🤦', 'yüzünü kapatan olamaz'),
    ],
  },
  {
    id: 'hearts',
    label: 'Kalpler',
    items: [
      e('❤️', 'kalp kırmızı sevgi aşk'),
      e('🧡', 'turuncu kalp'),
      e('💛', 'sarı kalp'),
      e('💚', 'yeşil kalp'),
      e('💙', 'mavi kalp'),
      e('💜', 'mor kalp'),
      e('🖤', 'siyah kalp'),
      e('💔', 'kırık kalp üzgün'),
      e('❤️‍🔥', 'yanan kalp tutku'),
      e('💯', 'yüz tam puan kesinlikle'),
      e('✨', 'parıltı yıldız'),
      e('🔥', 'ateş yangın harika'),
    ],
  },
  {
    id: 'things',
    label: 'Nesneler',
    items: [
      e('🎉', 'kutlama konfeti parti tebrikler'),
      e('🎂', 'pasta doğum günü'),
      e('🎁', 'hediye'),
      e('🏆', 'kupa ödül kazandık'),
      e('⚽', 'futbol top maç'),
      e('🎮', 'oyun konsol'),
      e('🎧', 'kulaklık müzik'),
      e('🎵', 'müzik nota şarkı'),
      e('☕', 'kahve çay sıcak'),
      e('🍕', 'pizza yemek'),
      e('🍺', 'bira içki şerefe'),
      e('🍿', 'patlamış mısır film'),
      e('💻', 'bilgisayar laptop'),
      e('📌', 'raptiye sabitle'),
      e('📎', 'ataç dosya'),
      e('⏰', 'saat alarm geç'),
      e('🚀', 'roket hızlı başla'),
      e('💡', 'ampul fikir'),
      e('✅', 'tamam onay tik yapıldı'),
      e('❌', 'çarpı hayır yanlış'),
      e('❓', 'soru'),
      e('❗', 'ünlem önemli'),
      e('⚠️', 'uyarı dikkat'),
      e('🆗', 'tamam ok'),
      e('🇹🇷', 'türkiye bayrak'),
    ],
  },
]

export const ALL_EMOJI: EmojiEntry[] = EMOJI_GROUPS.flatMap((group) => group.items)

/** A few to tap at once, in the phone's action sheet. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉']

/** Turkish-aware lower case (İ → i, I → ı). */
export function turkishLower(text: string): string {
  return text.toLocaleLowerCase('tr-TR')
}

/** Entries whose keywords start with every typed word (prefix match, any order). */
export function searchEmoji(query: string, entries: readonly EmojiEntry[] = ALL_EMOJI): EmojiEntry[] {
  const terms = turkishLower(query).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return [...entries]
  return entries.filter((entry) => {
    const words = turkishLower(entry.words).split(' ')
    return terms.every((term) => entry.emoji === term || words.some((word) => word.startsWith(term)))
  })
}
