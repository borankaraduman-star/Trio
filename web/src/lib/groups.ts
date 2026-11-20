import { fold } from './notify/mentions'

/**
 * CONTRACT-V10-GROUPS: what changes when the group is ten or fifteen people
 * instead of three. Pure helpers; the engine and the components use them.
 */

/**
 * The room's people count and its cap: "5/8". `max` is `ready.voice_room_max`
 * (null from a server that predates it: no cap known, no count of it shown).
 */
export function roomCount(count: number, max: number | null): string | null {
  if (max === null || count <= 0) return null
  return `${count}/${max}`
}

/** Whether a join into a room of `count` people would be refused (my own place never counts). */
export function roomIsFull(count: number, max: number | null, mine: boolean): boolean {
  return max !== null && !mine && count >= max
}

export function roomFullMessage(max: number): string {
  return `Oda dolu (${max}/${max}). Ses odasında herkes herkese ayrı ayrı ses gönderir; bu sunucuda bir odaya en çok ${max} kişi girebilir. Biri ayrılınca katılabilirsin ya da başka bir ses kanalı aç.`
}

export interface CameraEncoding {
  maxBitrate: number
  scaleResolutionDownBy: number
  maxFramerate: number
}

/**
 * The camera's encoding for a room of `roomSize` people (me included). In a
 * mesh every camera is encoded and uploaded once PER VIEWER, so a bigger room
 * sends each one smaller. Applied with `setParameters` on each camera sender
 * (never a renegotiation, CLAUDE.md); null = the browser's own choice (up to
 * 4 people, as before V10).
 *
 * The steps are measured in e2e 81 (CONTRACT-V10-GROUPS §3): 720p at
 * Chromium's default is ~1.3-2.5 Mbit/s per viewer; 7 viewers of that is more
 * than most home uploads.
 */
export function cameraEncodingFor(roomSize: number): CameraEncoding | null {
  if (roomSize <= 4) return null
  if (roomSize <= 6) return { maxBitrate: 600_000, scaleResolutionDownBy: 1.5, maxFramerate: 30 }
  return { maxBitrate: 350_000, scaleResolutionDownBy: 2, maxFramerate: 24 }
}

/** A stable key for an encoding (null included), to skip writes that change nothing. */
export function cameraEncodingKey(encoding: CameraEncoding | null): string {
  return encoding === null ? 'default' : `${encoding.maxBitrate}/${encoding.scaleResolutionDownBy}/${encoding.maxFramerate}`
}

/**
 * Names for a line with little room ("Konuşuyor: Ayşe, Mehmet +3"): the first
 * `shown` names and how many more.
 */
export function namesWithMore(names: readonly string[], shown = 2): string {
  if (names.length <= shown + 1) return names.join(', ')
  return `${names.slice(0, shown).join(', ')} +${names.length - shown}`
}

/**
 * The tiles a stage shows at once before the rest fold into a "+N" tile. The
 * first are the ones the viewer most needs: screens, then whoever spoke last.
 */
export function stageTileLimit(phone: boolean): number {
  return phone ? 4 : 9
}

/**
 * The order tiles take on a crowded stage: screens first, then people who are
 * speaking (or spoke most recently), then the rest in their given order.
 */
export function orderTiles<T extends { userId: number; kind: 'screen' | 'camera' }>(
  tiles: readonly T[],
  lastSpoke: ReadonlyMap<number, number>,
): T[] {
  const index = new Map(tiles.map((tile, i) => [tile, i]))
  return [...tiles].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'screen' ? -1 : 1
    const spokeA = lastSpoke.get(a.userId) ?? -1
    const spokeB = lastSpoke.get(b.userId) ?? -1
    if (spokeA !== spokeB) return spokeB - spokeA
    return (index.get(a) ?? 0) - (index.get(b) ?? 0)
  })
}

function folded(text: string): string {
  return fold(text).folded.join('')
}

/**
 * A "@" suggestion list: names that start with the query first, then names
 * with a word that starts with it, then names that contain it; folded as the
 * mention matcher folds (Turkish İ/ı, case), so "@IŞI" and "@işı" offer "Işıl".
 */
export function filterMentionNames<T extends { name: string }>(people: readonly T[], query: string, limit = 8): T[] {
  const q = folded(query)
  const starts: T[] = []
  const words: T[] = []
  const contains: T[] = []
  for (const person of people) {
    const name = folded(person.name)
    if (name.startsWith(q)) starts.push(person)
    else if (q !== '' && name.split(/\s+/).some((word) => word.startsWith(q))) words.push(person)
    else if (q !== '' && name.includes(q)) contains.push(person)
  }
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, 'tr')
  return [...starts.sort(byName), ...words.sort(byName), ...contains.sort(byName)].slice(0, limit)
}

/**
 * The "@" being typed at the caret: its start and the query after it, or
 * null. The "@" must start a word (not "ali@example.com") and the query may
 * hold spaces (names do) but no newline, and is at most 32 characters.
 */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at === -1) return null
  const query = before.slice(at + 1)
  if (query.length > 32 || /[\n@]/.test(query) || /^\s/.test(query)) return null
  const prev = at === 0 ? '' : before[at - 1]
  if (prev !== '' && /[\p{L}\p{N}\p{M}_]/u.test(prev)) return null
  return { start: at, query }
}
