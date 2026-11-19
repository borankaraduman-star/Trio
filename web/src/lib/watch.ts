/**
 * "İzlemeyi bırak" (CONTRACT-V6-VOICE §2): a viewer tells the sharer it is
 * not watching their screen, and the sharer pauses that viewer's encoding.
 *
 * On the wire it is one more client-to-client form inside the opaque
 * `signal.data` the server relays:
 *
 *     {"watch": {"stream": "<MediaStream id>" | "screen", "on": bool}}
 *
 * `stream` names the share the viewer means (the id from the sharer's
 * `meta`), so a late "off" for a share that has since been replaced by a new
 * one is ignored; "screen" means whatever the sharer shares now. A client
 * that predates this ignores the form (it is neither a description, a
 * candidate, a negotiate, a reset nor a meta).
 */

export interface WatchSignal {
  stream: string
  on: boolean
}

export function parseWatch(data: unknown): WatchSignal | null {
  if (typeof data !== 'object' || data === null) return null
  const watch = (data as { watch?: unknown }).watch
  if (typeof watch !== 'object' || watch === null) return null
  const { stream, on } = watch as { stream?: unknown; on?: unknown }
  if (typeof stream !== 'string' || stream.length === 0 || stream.length > 128) return null
  if (typeof on !== 'boolean') return null
  return { stream, on }
}

/** Whether a `watch` signal is about the share `current` (the sharer's screen stream id). */
export function watchApplies(signal: WatchSignal, current: string | null): boolean {
  if (current === null) return false
  return signal.stream === 'screen' || signal.stream === current
}
