export type TextPart =
  | { type: 'text'; value: string }
  | { type: 'link'; value: string; href: string }

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi
const TRAILING = /[.,;:!?'"»”’\])}]$/

/** Cut punctuation that belongs to the sentence, not to the address. */
function trimTrailing(candidate: string): string {
  let url = candidate
  while (url.length > 0 && TRAILING.test(url)) {
    const last = url[url.length - 1]
    if (last === ')' || last === ']' || last === '}') {
      const open = last === ')' ? '(' : last === ']' ? '[' : '{'
      const opens = url.split(open).length - 1
      const closes = url.split(last).length - 1
      // A balanced bracket is part of the address (Wikipedia-style links).
      if (closes <= opens) break
    }
    url = url.slice(0, -1)
  }
  return url
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
