export interface GroupableMessage {
  key: string
  author: { id: number }
  created_at: string
}

export type Row<M extends GroupableMessage> =
  | { type: 'day'; key: string; date: Date }
  | { type: 'message'; key: string; message: M; showHeader: boolean }

/** Consecutive messages by one author closer than this share a header. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000

/** The local calendar day of a date, as `YYYY-MM-DD`. */
export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Turn messages (oldest first) into rows: a separator whenever the local day
 * changes, and `showHeader` false for a message that continues its author's
 * run on the same day within the grouping window.
 */
export function buildRows<M extends GroupableMessage>(messages: readonly M[]): Row<M>[] {
  const rows: Row<M>[] = []
  interface Previous {
    authorId: number
    time: number
    day: string
  }
  let previous: Previous | null = null
  let lastDay = 'unknown'
  let lastTime = 0

  for (const message of messages) {
    const date = new Date(message.created_at)
    const time = date.getTime()
    const valid = !Number.isNaN(time)
    const day: string = valid ? dayKey(date) : lastDay

    if (!previous || previous.day !== day) {
      if (valid) rows.push({ type: 'day', key: `day-${day}`, date })
      previous = null
    }

    const continues =
      previous !== null &&
      previous.authorId === message.author.id &&
      valid &&
      time - previous.time < GROUP_WINDOW_MS &&
      time >= previous.time

    rows.push({ type: 'message', key: message.key, message, showHeader: !continues })
    lastDay = day
    if (valid) lastTime = time
    previous = { authorId: message.author.id, time: lastTime, day }
  }
  return rows
}

export function dayLabel(date: Date, now: Date = new Date()): string {
  const key = dayKey(date)
  if (key === dayKey(now)) return 'Bugün'
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (key === dayKey(yesterday)) return 'Dün'
  return date.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' })
}

export function timeLabel(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
}

export function typingLabel(names: readonly string[]): string {
  if (names.length === 0) return ''
  if (names.length === 1) return `${names[0]} yazıyor…`
  if (names.length === 2) return `${names[0]} ve ${names[1]} yazıyor…`
  return 'Birkaç kişi yazıyor…'
}
