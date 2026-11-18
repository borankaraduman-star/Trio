export type TextPart =
  | { type: 'text'; value: string }
  | { type: 'link'; value: string; href: string }

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi
/** Punctuation that, at the very end of a candidate, belongs to the sentence. */
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', "'", '"', '»', '”', '’', ']', ')', '}'])
const OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

/**
 * Cut punctuation that belongs to the sentence, not to the address.
 *
 * Linear: the brackets are counted once, and each character cut from the end
 * updates the counts instead of recounting the whole candidate (that was
 * O(n²): one 4000-character message of `http://a.b/))))…` took ~90 ms).
 * A closing bracket stays when it is balanced by an opening one before it
 * (Wikipedia-style addresses).
 */
export function trimTrailing(candidate: string): string {
  const length = candidate.length
  const counts: Record<string, number> = { '(': 0, ')': 0, '[': 0, ']': 0, '{': 0, '}': 0 }
  for (let i = 0; i < length; i += 1) {
    const char = candidate[i]
    if (char in counts) counts[char] += 1
  }
  let end = length
  while (end > 0) {
    const last = candidate[end - 1]
    if (!TRAILING.has(last)) break
    const open = OPENER[last]
    if (open !== undefined) {
      if (counts[last] <= counts[open]) break
      counts[last] -= 1
    }
    end -= 1
  }
  return end === length ? candidate : candidate.slice(0, end)
}

function safeHref(candidate: string): string | null {
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (!url.hostname) return null
    return url.href
  } catch {
    return null
  }
}

/**
 * Split message text into plain text and http(s) links. The result is data,
 * rendered by React as text nodes and anchors: nothing here is ever HTML.
 */
export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = []
  let cursor = 0
  const pushText = (value: string) => {
    if (!value) return
    const previous = parts[parts.length - 1]
    if (previous && previous.type === 'text') previous.value += value
    else parts.push({ type: 'text', value })
  }

  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0
    // "xhttp://…" is not a link start; require a boundary before the scheme.
    if (start > 0 && /[A-Za-z0-9]/.test(text[start - 1])) continue
    const value = trimTrailing(match[0])
    const href = safeHref(value)
    if (!href) continue
    pushText(text.slice(cursor, start))
    parts.push({ type: 'link', value, href })
    cursor = start + value.length
  }
  pushText(text.slice(cursor))
  return parts
}
