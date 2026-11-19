/**
 * Reaction keys (CONTRACT-V4 B). The server compares keys byte for byte, so
 * `❤` and `❤️` would be two different reactions. Every key this client sends
 * goes through `normalizeReactionKey`, which gives the FULLY QUALIFIED form:
 * VS16 (U+FE0F) after each pictographic character whose default presentation
 * is text (❤, ☺, ✌, ©…), unless a skin-tone modifier follows it (☝🏻 is
 * already an emoji), and after the base of a keycap (1⃣ → 1️⃣). A VS15 (text
 * presentation) becomes VS16: a reaction is always shown as an emoji.
 * Everything else is kept as it is, `:name:` keys included.
 */
const VS15 = '︎'
const VS16 = '️'
const KEYCAP = '⃣'
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u
const MODIFIER = /\p{Emoji_Modifier}/u
const KEYCAP_BASE = /^[0-9#*]$/
const NAMED = /^:[a-z0-9_]{1,32}:$/

export function normalizeReactionKey(key: string): string {
  if (NAMED.test(key)) return key
  const points = [...key].filter((point) => point !== VS15 && point !== VS16)
  let result = ''
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    const next = points[index + 1]
    result += point
    const keycap = KEYCAP_BASE.test(point) && next === KEYCAP
    const textDefault =
      PICTOGRAPHIC.test(point) && !EMOJI_PRESENTATION.test(point) && !(next !== undefined && MODIFIER.test(next))
    if (keycap || textDefault) result += VS16
  }
  return result
}

/** UTF-8 length, the unit of the server's 64-byte limit. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

/** The key as it goes into the URL path. */
export function reactionPath(key: string): string {
  return encodeURIComponent(normalizeReactionKey(key))
}
