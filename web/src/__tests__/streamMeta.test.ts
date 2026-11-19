import { describe, expect, it } from 'vitest'
import { classifyStreams, EMPTY_META, parseMeta, sameMeta } from '../lib/streamMeta'

function stream(id: string, kinds: ('audio' | 'video')[]) {
  const tracks = kinds.map((kind) => ({ kind }))
  return { id, getTracks: () => tracks, getVideoTracks: () => tracks.filter((t) => t.kind === 'video') }
}

describe('parseMeta', () => {
  it('reads the meta signal', () => {
    expect(parseMeta({ meta: { camera: 'c1', screen: null } })).toEqual({ camera: 'c1', screen: null })
    expect(parseMeta({ meta: { camera: null, screen: 's1' } })).toEqual({ camera: null, screen: 's1' })
    expect(parseMeta({ meta: {} })).toEqual(EMPTY_META)
    expect(parseMeta({ meta: { camera: 5, screen: '' } })).toEqual(EMPTY_META)
  })

  it('is null for anything that is not a meta signal', () => {
    expect(parseMeta({ description: { type: 'offer' } })).toBeNull()
    expect(parseMeta({ candidate: null })).toBeNull()
    expect(parseMeta(null)).toBeNull()
    expect(parseMeta({ meta: 'x' })).toBeNull()
  })

  it('compares', () => {
    expect(sameMeta({ camera: 'a', screen: null }, { camera: 'a', screen: null })).toBe(true)
    expect(sameMeta({ camera: 'a', screen: null }, { camera: null, screen: 'a' })).toBe(false)
  })
})

describe('classifyStreams', () => {
  const mic = stream('mic', ['audio'])
  const cam = stream('cam', ['video'])
  const screen = stream('scr', ['video', 'audio'])

  it('uses meta to tell camera from screen', () => {
    const result = classifyStreams([mic, cam, screen], { camera: 'cam', screen: 'scr' })
    expect(result).toEqual({ audio: mic, camera: cam, screen, music: null })
  })

  it('a video stream named nowhere is the screen (v1 fallback); audio-only is the mic', () => {
    expect(classifyStreams([mic, screen], EMPTY_META)).toEqual({ audio: mic, camera: null, screen, music: null })
  })

  it('a camera without a screen', () => {
    expect(classifyStreams([mic, cam], { camera: 'cam', screen: null })).toEqual({ audio: mic, camera: cam, screen: null, music: null })
  })

  it('the named screen wins over an unnamed video stream', () => {
    const stray = stream('stray', ['video'])
    expect(classifyStreams([screen, stray], { camera: null, screen: 'scr' }).screen).toBe(screen)
    expect(classifyStreams([stray, screen], { camera: null, screen: 'scr' }).screen).toBe(screen)
  })

  it('ignores empty streams', () => {
    const empty = stream('cam', [])
    expect(classifyStreams([mic, empty], { camera: 'cam', screen: null }).camera).toBeNull()
  })

  it('meta naming a stream we never got changes nothing else', () => {
    expect(classifyStreams([mic, screen], { camera: 'gone', screen: null })).toEqual({ audio: mic, camera: null, screen, music: null })
  })
})
