import { describe, expect, it } from 'vitest'
import { displayMediaOptions } from '../audio/screenAudio'

describe('displayMediaOptions', () => {
  it('asks for no sound by default', () => {
    expect(displayMediaOptions(false, { restrictOwnAudio: true })).toEqual({
      video: true,
      audio: false,
      selfBrowserSurface: 'exclude',
    })
  })

  it('asks the browser to leave out the call itself when it can', () => {
    expect(displayMediaOptions(true, { restrictOwnAudio: true })).toEqual({
      video: true,
      audio: { restrictOwnAudio: true },
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
    })
  })

  it('still shares sound where the constraint does not exist', () => {
    expect(displayMediaOptions(true, {})).toMatchObject({ audio: true, systemAudio: 'include' })
  })
})
