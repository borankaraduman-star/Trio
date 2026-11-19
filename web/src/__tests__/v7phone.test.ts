import { describe, expect, it } from 'vitest'
import {
  loadStageCollapsed,
  saveStageCollapsed,
  screenShareSupported,
  STAGE_COLLAPSED_KEY,
  stageSources,
  talkingLine,
} from '../lib/phone'

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    data,
  }
}

describe('V7 phone helpers', () => {
  it('knows a browser that cannot share a screen', () => {
    expect(screenShareSupported(undefined)).toBe(false)
    expect(screenShareSupported({})).toBe(false)
    expect(screenShareSupported({ getDisplayMedia: () => undefined })).toBe(true)
  })

  it('remembers the stage collapse per device, and survives storage that throws', () => {
    const storage = memoryStorage()
    expect(loadStageCollapsed(storage)).toBe(false)
    saveStageCollapsed(true, storage)
    expect(storage.data.get(STAGE_COLLAPSED_KEY)).toBe('1')
    expect(loadStageCollapsed(storage)).toBe(true)
    saveStageCollapsed(false, storage)
    expect(storage.data.has(STAGE_COLLAPSED_KEY)).toBe(false)
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    }
    expect(loadStageCollapsed(broken)).toBe(false)
    expect(() => saveStageCollapsed(true, broken)).not.toThrow()
  })

  it('says who is talking, with "Sen" for me', () => {
    const nameOf = (id: number) => ({ 1: 'Ayşe', 2: 'Mehmet' })[id] ?? `#${id}`
    expect(talkingLine([2, 3], 3, 3, nameOf)).toBe('Konuşuyor: Mehmet, Sen')
    expect(talkingLine([], 3, 3, nameOf)).toBe('3 kişi')
    expect(talkingLine([], 3, 1, nameOf)).toBe('Odada yalnızsın')
  })

  it('names what the stage shows, leaving out a screen I stopped watching', () => {
    const nameOf = (id: number) => ({ 1: 'Ayşe', 2: 'Mehmet' })[id] ?? `#${id}`
    expect(
      stageSources(
        {
          remoteScreens: [{ userId: 1 }, { userId: 2 }],
          hiddenScreens: { 2: 'stream-id' },
          remoteCameras: [{ userId: 2 }],
          localScreen: null,
          localCamera: {},
        },
        nameOf,
      ),
    ).toEqual(['Ayşe ekranı', 'Mehmet kamerası', 'Senin kameran'])
  })
})
