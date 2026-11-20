/**
 * CONTRACT-V12-WATCHING §3: "only pay for what you watch". Every place that
 * shows a remote screen (its stage tile, the theatre, a mini window, the
 * browser's picture-in-picture) reports how large it shows it; the largest
 * wins, the viewer's own choice for that share caps it ("Hafif izleme" →
 * `thumb`, "Sadece ses" → `audio`), and the result is told to the sharer
 * through the engine (`watch {on: true, size}`), which sets that ONE viewer's
 * encoding with `setParameters` — never a renegotiation.
 *
 * Nothing showing it at all (the page hidden and no mini window) is `audio`:
 * the sound goes on, the picture is not sent until it is shown again (the
 * encoder restarts with a keyframe, ~0.2 s, CONTRACT-V6-VOICE §2).
 *
 * Shrinking is told after VIEW_SIZE_SETTLE_MS; growing at once (a viewer who
 * just focused a share must not wait for it to sharpen).
 */
import { largerSize, smallerSize, VIEW_SIZE_SETTLE_MS, type ViewSize } from '../lib/multishare'

export interface SizeSink {
  setViewSize(userId: number, size: ViewSize): void
}

export interface Caps {
  light: boolean
  audioOnly: boolean
}

/** Pure: the size to ask for, from the reports and the viewer's choice. */
export function wantedSize(reports: readonly ViewSize[], caps: Caps): ViewSize {
  if (caps.audioOnly) return 'audio'
  let size: ViewSize = 'audio'
  for (const report of reports) size = largerSize(size, report)
  if (caps.light) size = smallerSize(size, 'thumb')
  return size
}

const GROW_MS = 60

export class SizeCoordinator {
  private sink: SizeSink | null = null
  private readonly reports = new Map<number, Map<string, ViewSize>>()
  private readonly told = new Map<number, ViewSize>()
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>()
  private capsOf: (userId: number) => Caps = () => ({ light: false, audioOnly: false })

  attach(sink: SizeSink | null, capsOf?: (userId: number) => Caps): void {
    this.sink = sink
    if (capsOf) this.capsOf = capsOf
    this.told.clear()
    for (const userId of this.reports.keys()) this.schedule(userId)
  }

  /** `size` null = this place no longer shows the share. */
  report(userId: number, source: string, size: ViewSize | null): void {
    let map = this.reports.get(userId)
    if (size === null) {
      if (!map?.delete(source)) return
    } else {
      if (!map) {
        map = new Map()
        this.reports.set(userId, map)
      }
      if (map.get(source) === size) return
      map.set(source, size)
    }
    this.schedule(userId)
  }

  /** The viewer's choice for a share changed: re-evaluate. */
  refresh(userId?: number): void {
    if (userId === undefined) for (const id of this.reports.keys()) this.schedule(id)
    else this.schedule(userId)
  }

  /** What would be asked for now (for the UI and tests). */
  current(userId: number): ViewSize {
    return wantedSize([...(this.reports.get(userId)?.values() ?? [])], this.capsOf(userId))
  }

  /** What was last told to the sharer. */
  toldSize(userId: number): ViewSize {
    return this.told.get(userId) ?? 'full'
  }

  /** The share is gone: forget it (a new share starts at full on the sharer's side). */
  forget(userId: number): void {
    this.reports.delete(userId)
    this.told.delete(userId)
    const timer = this.timers.get(userId)
    if (timer) clearTimeout(timer)
    this.timers.delete(userId)
  }

  private schedule(userId: number): void {
    const want = this.current(userId)
    const told = this.toldSize(userId)
    const timer = this.timers.get(userId)
    if (timer) clearTimeout(timer)
    if (want === told) {
      this.timers.delete(userId)
      return
    }
    const growing = largerSize(want, told) === want
    this.timers.set(
      userId,
      setTimeout(
        () => {
          this.timers.delete(userId)
          const now = this.current(userId)
          if (now === this.toldSize(userId)) return
          this.told.set(userId, now)
          this.sink?.setViewSize(userId, now)
        },
        growing ? GROW_MS : VIEW_SIZE_SETTLE_MS,
      ),
    )
  }
}

export const viewSizes = new SizeCoordinator()
