import { describe, expect, it } from 'vitest'
import {
  ReleaseWatch,
  bandText,
  shouldAskShell,
  HINT_RETRY_MS,
  RELEASE_POLL_MS,
  FORCE_GAP_MS,
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
      inVoice: false,
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

describe('the band in the shell\'s own states (§5)', () => {
  it('says available, downloading and ready in one line; in a call, "odadan çıkınca"', () => {
    expect(bandText({ kind: 'available', version: '0.9.1', inVoice: false })).toBe(
      'Masaüstü uygulamasının yeni sürümü var (0.9.1).',
    )
    expect(bandText({ kind: 'downloading', version: '0.9.1', percent: 40, inVoice: false })).toBe(
      'Güncelleme indiriliyor: 0.9.1 (%40)',
    )
    expect(bandText({ kind: 'downloading', version: '0.9.1', percent: 40, inVoice: true })).toBe(
      'Güncelleme indiriliyor: 0.9.1 (%40) — sesli odadan çıkınca kurulabilir',
    )
    expect(bandText({ kind: 'ready', version: '0.9.1', inVoice: false })).toBe('Güncelleme hazır: 0.9.1')
    expect(bandText({ kind: 'ready', version: '0.9.1', inVoice: true })).toBe(
      'Güncelleme hazır: 0.9.1 — sesli odadan çıkınca kurulabilir',
    )
  })
})

describe('"look now": the page asks the shell when it learns of a newer desktop release (§4a)', () => {
  const ask = {
    appVersion: '0.9.0',
    hasUpdater: true,
    shell: shell({ status: 'up-to-date', currentVersion: '0.9.0' }),
    release: release('0.9.1'),
    last: null,
    now: 1_000_000,
  }
  it('asks when the release is newer and the shell idles', () => {
    expect(shouldAskShell(ask)).toBe(true)
    expect(shouldAskShell({ ...ask, shell: shell({ status: 'idle' }) })).toBe(true)
    expect(shouldAskShell({ ...ask, shell: shell({ status: 'error', error: 'internet bağlantısı yok' }) })).toBe(true)
  })
  it('never for an old app without the updater, a manual shell, no newer release or a busy shell', () => {
    expect(shouldAskShell({ ...ask, hasUpdater: false })).toBe(false)
    expect(shouldAskShell({ ...ask, shell: null })).toBe(false)
    expect(shouldAskShell({ ...ask, shell: shell({ capability: 'manual', status: 'manual', reason: 'unsigned-mac' }) })).toBe(false)
    expect(shouldAskShell({ ...ask, release: release('0.9.0') })).toBe(false)
    expect(shouldAskShell({ ...ask, release: null })).toBe(false)
    for (const status of ['checking', 'downloading', 'ready', 'installing'] as const) {
      expect(shouldAskShell({ ...ask, shell: shell({ status, version: '0.9.1' }) })).toBe(false)
    }
    // Automatic download off and the shell already knows this version: it waits for "İndir".
    expect(shouldAskShell({ ...ask, shell: shell({ status: 'available', version: '0.9.1' }) })).toBe(false)
    expect(shouldAskShell({ ...ask, shell: shell({ status: 'available', version: '0.9.0-rc.1' }) })).toBe(true)
    // A download that failed is not retried from the page (a file failing its hash would be fetched again and again).
    expect(shouldAskShell({ ...ask, shell: shell({ status: 'error', version: '0.9.1', error: 'indirilen dosya doğrulanamadı' }) })).toBe(false)
  })
  it('once per version per ten minutes; a newer version asks at once', () => {
    const last = { version: '0.9.1', at: ask.now }
    expect(shouldAskShell({ ...ask, last })).toBe(false)
    expect(shouldAskShell({ ...ask, last, now: ask.now + HINT_RETRY_MS - 1 })).toBe(false)
    expect(shouldAskShell({ ...ask, last, now: ask.now + HINT_RETRY_MS })).toBe(true)
    expect(shouldAskShell({ ...ask, last, release: release('0.9.2') })).toBe(true)
  })
})

describe('the release is kept fresh while the app is open (§4a)', () => {
  function watch() {
    let t = 0
    let tick: (() => void) | null = null
    let version = '0.9.0'
    let asked = 0
    let fail = false
    const w = new ReleaseWatch({
      fetchRelease: async () => {
        asked++
        if (fail) throw new Error('offline')
        return release(version)
      },
      now: () => t,
      setInterval: (cb) => {
        tick = cb
        return 1
      },
      clearInterval: () => {
        tick = null
      },
    })
    return {
      w,
      advance: (ms: number) => {
        t += ms
      },
      fire: () => tick?.(),
      get ticking() {
        return tick !== null
      },
      publish: (v: string) => {
        version = v
      },
      get asked() {
        return asked
      },
      fail: (on: boolean) => {
        fail = on
      },
    }
  }
  const settle = () => new Promise((r) => setTimeout(r, 0))

  it('asks on subscribe, then every poll interval; a new release reaches the listener', async () => {
    const h = watch()
    const seen: (string | null)[] = []
    const off = h.w.subscribe((r) => seen.push(r?.version ?? null))
    await settle()
    expect(h.asked).toBe(1)
    h.publish('0.9.1')
    h.advance(RELEASE_POLL_MS)
    h.fire()
    await settle()
    expect(h.asked).toBe(2)
    expect(seen).toEqual(['0.9.0', '0.9.1'])
    off()
    expect(h.ticking).toBe(false)
  })
  it('a reconnect asks again (not more than once per half minute); a plain refresh respects the interval', async () => {
    const h = watch()
    h.w.subscribe(() => undefined)
    await settle()
    await h.w.refresh()
    expect(h.asked).toBe(1)
    await h.w.refresh(true)
    expect(h.asked).toBe(1)
    h.advance(FORCE_GAP_MS)
    await h.w.refresh(true)
    expect(h.asked).toBe(2)
  })
  it('a failed ask keeps the release it knew', async () => {
    const h = watch()
    h.w.subscribe(() => undefined)
    await settle()
    h.fail(true)
    h.advance(RELEASE_POLL_MS)
    await h.w.refresh()
    expect(h.w.current?.version).toBe('0.9.0')
  })
})
