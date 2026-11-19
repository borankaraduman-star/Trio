import { describe, expect, it } from 'vitest'
import {
  detectVisitor,
  formatDate,
  formatSize,
  otherFiles,
  powershellCheck,
  primaryFile,
  readDownloads,
  shellCheck,
  type DownloadFile,
} from '../indir/platform'

const UA = {
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
}

describe('detectVisitor', () => {
  it('reads the desktop systems', () => {
    expect(detectVisitor({ userAgent: UA.windows })).toBe('windows')
    expect(detectVisitor({ userAgent: UA.linux })).toBe('linux')
    expect(detectVisitor({ userAgent: UA.chromebook })).toBe('unknown')
    expect(detectVisitor({ userAgent: 'curl/8' })).toBe('unknown')
  })

  it('treats phones and an iPad in desktop mode as phones', () => {
    expect(detectVisitor({ userAgent: UA.android })).toBe('phone')
    expect(detectVisitor({ userAgent: UA.iphone })).toBe('phone')
    expect(detectVisitor({ userAgent: UA.mac, maxTouchPoints: 5 })).toBe('phone')
  })

  it('tells Apple Silicon from Intel when the browser says, and guesses Apple Silicon otherwise', () => {
    expect(detectVisitor({ userAgent: UA.mac, architecture: 'arm' })).toBe('mac-arm64')
    expect(detectVisitor({ userAgent: UA.mac, architecture: 'x86' })).toBe('mac-x64')
    expect(detectVisitor({ userAgent: UA.mac, gpu: 'Apple M2' })).toBe('mac-arm64')
    expect(detectVisitor({ userAgent: UA.mac, gpu: 'Intel(R) Iris(TM) Plus Graphics' })).toBe('mac-x64')
    expect(detectVisitor({ userAgent: UA.mac })).toBe('mac-arm64')
  })
})

const files: DownloadFile[] = [
  { platform: 'linux', name: 'Trio-0.5.0-linux-x86_64.AppImage', size: 3, sha256: null, url: '/indir/dosya/linux' },
  { platform: 'windows', name: 'Trio-0.5.0-win-x64.exe', size: 1, sha256: 'a'.repeat(64), url: '/indir/dosya/windows' },
  { platform: 'mac-x64', name: 'Trio-0.5.0-mac-x64.dmg', size: 2, sha256: null, url: '/indir/dosya/mac-x64' },
]

describe('choosing files', () => {
  it('puts the visitor first and the rest in a fixed order', () => {
    const primary = primaryFile('windows', files)
    expect(primary?.platform).toBe('windows')
    expect(otherFiles(files, primary).map((f) => f.platform)).toEqual(['mac-x64', 'linux'])
    expect(primaryFile('mac-arm64', files)).toBeNull()
    expect(primaryFile('phone', files)).toBeNull()
  })
})

describe('formatting', () => {
  it('writes sizes and dates in Turkish', () => {
    expect(formatSize(92_274_688)).toBe('88 MB')
    expect(formatSize(2048)).toBe('2 KB')
    expect(formatDate('2026-11-18T09:30:00Z')).toBe('18 Kasım 2026')
    expect(formatDate('nope')).toBeNull()
    expect(formatDate(null)).toBeNull()
  })

  it('builds the hash checks', () => {
    expect(powershellCheck('Trio.exe', 'ab'.repeat(32))).toBe(
      `(Get-FileHash "$env:USERPROFILE\\Downloads\\Trio.exe" -Algorithm SHA256).Hash -eq "${'AB'.repeat(32)}"`,
    )
    expect(shellCheck('mac-arm64', 'T.dmg', 'f'.repeat(64))).toContain('shasum -a 256 ~/Downloads/T.dmg')
    expect(shellCheck('linux', 'T.AppImage', 'f'.repeat(64))).toContain('sha256sum "$(xdg-user-dir DOWNLOAD)/T.AppImage"')
  })
})

describe('readDownloads', () => {
  it('keeps only what it understands', () => {
    const read = readDownloads({
      version: '0.5.0',
      published_at: '2026-11-18T09:30:00Z',
      signed: { windows: true, mac: 'yes' },
      files: [
        files[1],
        { ...files[0], url: 'https://evil.test/x' },
        { ...files[2], platform: 'android' },
        { ...files[2], sha256: 'NOT-A-HASH' },
        null,
      ],
    })
    expect(read.signed).toEqual({ windows: true, mac: false })
    expect(read.files.map((f) => f.platform)).toEqual(['windows', 'mac-x64'])
    expect(read.files[1].sha256).toBeNull()
    expect(readDownloads(null).files).toEqual([])
  })
})
