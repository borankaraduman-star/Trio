import { describe, expect, it } from 'vitest'
import { ENCODINGS, isEncodedAs, looksLikeHeic } from '../lib/imageEncode'
import { decodeErrorMessage } from '../components/ImageField'
import { profileErrorMessage } from '../lib/profileApi'
import { ApiError } from '../api'

describe('encoding', () => {
  it('prefers WebP, then JPEG', () => {
    expect(ENCODINGS.map((e) => e.type)).toEqual(['image/webp', 'image/jpeg'])
  })

  it('takes a result only when it really is the type asked for', () => {
    expect(isEncodedAs({ type: 'image/webp', size: 10 }, 'image/webp')).toBe(true)
    // An engine without a WebP encoder answers with a PNG.
    expect(isEncodedAs({ type: 'image/png', size: 10 }, 'image/webp')).toBe(false)
    expect(isEncodedAs({ type: 'image/webp', size: 0 }, 'image/webp')).toBe(false)
    expect(isEncodedAs(null, 'image/jpeg')).toBe(false)
  })
})

describe('messages', () => {
  it('explain HEIC', () => {
    expect(looksLikeHeic({ type: 'image/heic', name: 'a' })).toBe(true)
    expect(looksLikeHeic({ type: '', name: 'IMG_1.HEIC' })).toBe(true)
    expect(looksLikeHeic({ type: 'image/jpeg', name: 'a.jpg' })).toBe(false)
    expect(decodeErrorMessage(new Error('x'), { type: 'image/heic', name: 'a.heic' })).toMatch(/HEIC/)
  })

  it('word the server refusals in Turkish, names as on the join screen', () => {
    expect(profileErrorMessage(new ApiError(409, 'NAME_TAKEN', ''), 'name')).toBe('Bu isim alınmış, başka bir isim dene.')
    expect(profileErrorMessage(new ApiError(422, 'INVALID_NAME', ''), 'name')).toBe('İsim 1–32 karakter olmalı.')
    expect(profileErrorMessage(new ApiError(422, 'INVALID_IMAGE', ''), 'image')).toMatch(/görüntü değil/)
    expect(profileErrorMessage(new ApiError(413, 'FILE_TOO_LARGE', ''), 'image')).toMatch(/2 MB/)
    expect(profileErrorMessage(new ApiError(429, 'RATE_LIMITED', '', 20), 'image')).toMatch(/20 saniye sonra/)
    expect(profileErrorMessage(new ApiError(0, 'NETWORK', ''), 'name')).toBe('Sunucuya ulaşılamadı.')
  })
})
