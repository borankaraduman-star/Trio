/**
 * Message length, counted exactly as the server counts it
 * (`server/trio_server/ws.py`): Python's `str.strip()` and then `len()`, i.e.
 * Unicode code points after trimming Python's whitespace set. No
 * normalisation. An emoji is one code point (two UTF-16 units, which is what
 * `maxLength` and `String.length` count); a flag is two, a family emoji with
 * joiners is several, an accent typed as a combining mark is its own one.
 */
export const MAX_MESSAGE_LENGTH = 4000
/** The counter shows from this many characters on. */
export const COUNTER_FROM = MAX_MESSAGE_LENGTH - 200

/** Python's `str.isspace()` set (it differs from JavaScript's `trim()`: U+0085 and U+001C–U+001F are in it, U+FEFF is not). */
const PY_SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const EDGES = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'g')

/** What the server will store: the text trimmed the way Python trims it. */
export function serverStrip(text: string): string {
  return text.replace(EDGES, '')
}

/** Code points, the unit of the server's limit. */
export function codePoints(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

export interface LengthCheck {
  /** The content as it would be sent. */
  content: string
  length: number
  over: number
  showCounter: boolean
}

export function checkLength(text: string): LengthCheck {
  const content = serverStrip(text)
  const length = codePoints(content)
  return {
    content,
    length,
    over: Math.max(0, length - MAX_MESSAGE_LENGTH),
    showCounter: length >= COUNTER_FROM,
  }
}

export function tooLongMessage(over: number): string {
  return `Mesaj çok uzun: en fazla ${MAX_MESSAGE_LENGTH} karakter olabilir. ${over} karakter fazla.`
}
