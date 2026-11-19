import type { StreamMeta } from '../types'

/** What a remote peer's streams are, given the `meta` signal it sent (CONTRACT-V2 §4). */
export interface ClassifiedStreams<S> {
  /** The microphone: an audio-only stream that is neither camera nor screen. */
  audio: S | null
  screen: S | null
  camera: S | null
  /** CONTRACT-V8-MUSIC: the audio-only stream named by `meta.music`; never the microphone. */
  music: S | null
}

interface StreamLike {
  id: string
  getTracks(): readonly unknown[]
  getVideoTracks(): readonly unknown[]
}

export const EMPTY_META: StreamMeta = { camera: null, screen: null }

/** `{"meta": {...}}` from a signal frame, or null when the frame is something else. */
export function parseMeta(data: unknown): StreamMeta | null {
  if (typeof data !== 'object' || data === null) return null
  const meta = (data as { meta?: unknown }).meta
  if (typeof meta !== 'object' || meta === null) return null
  const record = meta as Record<string, unknown>
  const id = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : null)
  const music = id(record.music)
  return { camera: id(record.camera), screen: id(record.screen), ...(music ? { music } : {}) }
}

export function sameMeta(a: StreamMeta, b: StreamMeta): boolean {
  return a.camera === b.camera && a.screen === b.screen && (a.music ?? null) === (b.music ?? null)
}

/**
 * Maps a peer's live (non-empty) streams to mic / screen / camera.
 *
 * - A stream named by `meta.camera` is the camera, by `meta.screen` the screen,
 *   by `meta.music` the music (CONTRACT-V8-MUSIC; never taken for the microphone).
 * - A stream in neither: with a video track it is treated as the screen (the
 *   contract's fallback, and v1 behaviour); audio-only it is the microphone.
 * - When several candidates compete for one slot, the one named by meta wins,
 *   then the most recently added (iteration order = insertion order).
 */
export function classifyStreams<S extends StreamLike>(
  streams: Iterable<S>,
  meta: StreamMeta,
): ClassifiedStreams<S> {
  let audio: S | null = null
  let screen: S | null = null
  let screenNamed = false
  let camera: S | null = null
  let music: S | null = null
  const musicId = meta.music ?? null
  for (const stream of streams) {
    if (stream.getTracks().length === 0) continue
    if (musicId !== null && stream.id === musicId) {
      music = stream
    } else if (meta.camera !== null && stream.id === meta.camera) {
      camera = stream
    } else if (meta.screen !== null && stream.id === meta.screen) {
      screen = stream
      screenNamed = true
    } else if (stream.getVideoTracks().length > 0) {
      if (!screenNamed) screen = stream
    } else {
      audio = stream
    }
  }
  return { audio, screen, camera, music }
}
