import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  desktopLine,
  desktopNotice,
  loadDismissed,
  manualReasonText,
  newerRelease,
  parseRelease,
  parseShellState,
  platformsFor,
  saveDismissed,
  statusText,
  updateText,
  DISMISSED_KEY,
  FIRST_SELF_UPDATING_VERSION,
  type DesktopRelease,
  type NoticeInput,
  type ShellUpdateState,
} from '../lib/desktopVersion'

describe('compareVersions', () => {
  it('orders by semver', () => {
    expect(compareVersions('0.4.0', '0.5.0')).toBeLessThan(0)
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.3+abc', '1.2.3')).toBe(0)
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBeLessThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0)
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0)
    expect(compareVersions('1.0.0-beta', '1.0.0-beta.1')).toBeLessThan(0)
    expect(compareVersions('unknown', '1.0.0')).toBeNull()
  })
})

const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) trio-desktop/0.7.1 Chrome/140 Electron/45.3.4 Safari/537.36'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Electron/45.3.4'
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Electron/45.3.4'

function release(version: string): DesktopRelease {
  return {
    version,
    files: (['windows', 'mac-arm64', 'mac-x64', 'linux'] as const).map((platform) => ({ platform, url: `/indir/dosya/${platform}` })),
  }
}

function shell(patch: Partial<ShellUpdateState> = {}): ShellUpdateState {
  return {
    capability: 'auto',
    reason: null,
    platform: 'windows',
    currentVersion: '0.8.0',
    autoDownload: true,
    status: 'up-to-date',
    version: null,
    percent: null,
    error: null,
    checkedAt: 1,
    inVoice: false,
    ...patch,
  }
}

const base: NoticeInput = { isDesktop: true, appVersion: '0.7.1', hasUpdater: false, shell: null, release: null, userAgent: WIN }

describe('the notice follows the newest DESKTOP release, not the server', () => {
  it('is nothing in a plain browser', () => {
    expect(desktopNotice({ ...base, isDesktop: false, release: release('0.8.0') })).toBeNull()
  })
  it('a web-only release (no newer desktop release) does not nag', () => {
    expect(desktopNotice({ ...base, release: release('0.7.1') })).toBeNull()
    expect(desktopNotice({ ...base, appVersion: '0.8.0', release: release('0.7.1') })).toBeNull()
  })
  it('no release information: no notice (never a guess from the server version)', () => {
    expect(desktopNotice({ ...base, release: null })).toBeNull()
  })
  it('an old app without the updater: a direct download for its own system', () => {
    expect(desktopNotice({ ...base, release: release('0.7.2') })).toEqual({
      kind: 'manual',
      version: '0.7.2',
      downloads: [{ platform: 'windows', url: '/indir/dosya/windows', label: 'İndir' }],
      lastManual: false,
    })
    const mac = desktopNotice({ ...base, userAgent: MAC, release: release('0.8.0') })
    expect(mac?.kind === 'manual' && mac.downloads.map((d) => d.platform)).toEqual(['mac-arm64', 'mac-x64'])
  })
  it('the last manual install is said on Windows and Linux when the new release has the updater, not on macOS', () => {
    const at = (userAgent: string, version: string) => {
      const notice = desktopNotice({ ...base, userAgent, release: release(version) })
      return notice?.kind === 'manual' ? notice.lastManual : null
    }
    expect(at(WIN, FIRST_SELF_UPDATING_VERSION)).toBe(true)
    expect(at(LINUX, '0.9.0')).toBe(true)
    expect(at(MAC, '0.9.0')).toBe(false)
    expect(at(WIN, '0.7.2')).toBe(false)
  })
  it('a build too old to say its version is older than any release', () => {
    expect(newerRelease(undefined, release('0.5.0'))).toBe(true)
    expect(desktopNotice({ ...base, appVersion: undefined, release: release('0.8.0') })?.kind).toBe('manual')
  })
  it('a missing platform file falls back to the download page', () => {
    const notice = desktopNotice({ ...base, release: { version: '0.8.0', files: [] } })
    expect(notice?.kind === 'manual' && notice.downloads).toEqual([])
  })
})

describe('inside an app that updates itself', () => {
  const auto = { ...base, appVersion: '0.8.0', hasUpdater: true, release: release('0.9.0') }
  it('shows the shell state, never the manual notice, while it works', () => {
    expect(desktopNotice({ ...auto, shell: shell({ status: 'checking' }) })).toBeNull()
    expect(desktopNotice({ ...auto, shell: shell({ status: 'downloading', version: '0.9.0', percent: 40 }) })).toEqual({
      kind: 'downloading',
      version: '0.9.0',
      percent: 40,
    })
    expect(desktopNotice({ ...auto, shell: shell({ status: 'ready', version: '0.9.0' }) })).toEqual({
      kind: 'ready',
      version: '0.9.0',
      inVoice: false,
    })
    expect(desktopNotice({ ...auto, shell: shell({ status: 'ready', version: '0.9.0', inVoice: true }) })).toEqual({
      kind: 'ready',
      version: '0.9.0',
      inVoice: true,
    })
    expect(desktopNotice({ ...auto, shell: shell({ status: 'available', version: '0.9.0' }) })?.kind).toBe('available')
  })
  it('a failed self-update falls back to the direct download', () => {
    const notice = desktopNotice({ ...auto, shell: shell({ status: 'error', error: 'internet bağlantısı yok' }) })
    expect(notice).toMatchObject({ kind: 'manual', version: '0.9.0', lastManual: false })
  })
  it('a shell that cannot update here (unsigned mac) gets the manual notice for its own processor', () => {
    const notice = desktopNotice({
      ...auto,
      userAgent: MAC,
      shell: shell({ capability: 'manual', reason: 'unsigned-mac', status: 'manual', platform: 'mac-arm64' }),
    })
    expect(notice).toEqual({
      kind: 'manual',
      version: '0.9.0',
      downloads: [{ platform: 'mac-arm64', url: '/indir/dosya/mac-arm64', label: 'İndir (Apple Silicon)' }],
      lastManual: false,
    })
  })
  it('the bridge members present but the state not read yet: no notice from the auto side', () => {
    expect(desktopNotice({ ...auto, release: release('0.8.0') })).toBeNull()
  })
})

describe('reading what comes in', () => {
  it('parses /api/downloads defensively, only the server\'s own redirect URLs', () => {
    expect(parseRelease({ version: null, files: [] })).toBeNull()
    expect(parseRelease(null)).toBeNull()
    expect(
      parseRelease({
        version: '0.8.0',
        files: [
          { platform: 'windows', url: '/indir/dosya/windows' },
          { platform: 'linux', url: 'https://evil.example/x' },
          { platform: 'beos', url: '/indir/dosya/beos' },
        ],
      }),
    ).toEqual({ version: '0.8.0', files: [{ platform: 'windows', url: '/indir/dosya/windows' }] })
  })
  it('parses the shell state defensively', () => {
    expect(parseShellState(null)).toBeNull()
    expect(parseShellState({ capability: 'root', status: 'ready' })).toBeNull()
    expect(parseShellState({ capability: 'auto', status: 'ready', version: '0.9.0', platform: 'x' })).toMatchObject({
      capability: 'auto',
      status: 'ready',
      version: '0.9.0',
      platform: null,
      autoDownload: true,
      inVoice: false,
    })
  })
  it('guesses the platform of an old app from its user agent', () => {
    expect(platformsFor(null, WIN)).toEqual(['windows'])
    expect(platformsFor(null, LINUX)).toEqual(['linux'])
    expect(platformsFor(null, 'Mozilla/5.0 (Linux; Android 14)')).toEqual([])
    expect(platformsFor('mac-x64', MAC)).toEqual(['mac-x64'])
  })
})

describe('texts', () => {
  it('lines for Hakkında', () => {
    expect(desktopLine('0.4.0')).toBe('Masaüstü uygulaması 0.4.0')
    expect(desktopLine(undefined)).toBe('Masaüstü uygulaması (eski sürüm)')
    expect(statusText(shell())).toBe('Güncel')
    expect(statusText(shell({ status: 'downloading', percent: 40 }))).toBe('İndiriliyor %40')
    expect(statusText(shell({ status: 'error', error: 'internet bağlantısı yok' }))).toBe(
      'Güncelleme denetlenemedi (internet bağlantısı yok)',
    )
    expect(statusText(shell({ status: 'ready', version: '0.9.0' }))).toContain('Hazır: 0.9.0')
    expect(manualReasonText('unsigned-mac')).toContain('imzasız')
    expect(manualReasonText(null)).toBeNull()
  })
  it('text and per-version dismissal', () => {
    expect(updateText('0.5.0')).toBe('Masaüstü uygulamasının yeni sürümü var (0.5.0).')
    const data = new Map<string, string>()
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
    expect(loadDismissed(storage)).toBeNull()
    saveDismissed('0.5.0', storage)
    expect(data.get(DISMISSED_KEY)).toBe('0.5.0')
    expect(loadDismissed(storage)).toBe('0.5.0')
  })
})
