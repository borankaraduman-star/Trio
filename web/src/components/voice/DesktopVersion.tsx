import { useEffect, useState } from 'react'
import {
  DESKTOP_RELEASES_URL,
  ReleaseWatch,
  bandText,
  loadHint,
  loadLater,
  saveHint,
  saveLater,
  shouldAskShell,
  type HintRecord,
  LAST_MANUAL_TEXT,
  desktopLine,
  desktopNotice,
  loadDismissed,
  parseRelease,
  parseShellState,
  saveDismissed,
  statusText,
  updateText,
  type DesktopNotice,
  type DesktopRelease,
  type DownloadButton,
  type ShellUpdateState,
} from '../../lib/desktopVersion'
import type { TrioDesktopBridge } from '../../ptt'
import { CloseIcon } from '../icons2'

// CONTRACT-V10-UPDATE §4–5: the band in the app and the lines in Ayarlar ›
// Hakkında. The shell (when it has the update members) owns the update; the
// page only shows its state and passes on the user's clicks.

type Bridge = Partial<TrioDesktopBridge> & { isDesktop?: unknown }

function readBridge(): Bridge | null {
  const bridge = (globalThis as { trioDesktop?: Bridge }).trioDesktop
  return bridge && bridge.isDesktop === true ? bridge : null
}

/** All six V10 members present: an older app lacks them and gets exactly the manual notice. */
function updaterOf(bridge: Bridge | null): Required<
  Pick<TrioDesktopBridge, 'getUpdateState' | 'onUpdateState' | 'checkForUpdates' | 'downloadUpdate' | 'installUpdate' | 'setAutoUpdate'>
> | null {
  if (!bridge) return null
  const { getUpdateState, onUpdateState, checkForUpdates, downloadUpdate, installUpdate, setAutoUpdate } = bridge
  if (
    typeof getUpdateState !== 'function' ||
    typeof onUpdateState !== 'function' ||
    typeof checkForUpdates !== 'function' ||
    typeof downloadUpdate !== 'function' ||
    typeof installUpdate !== 'function' ||
    typeof setAutoUpdate !== 'function'
  ) {
    return null
  }
  return { getUpdateState, onUpdateState, checkForUpdates, downloadUpdate, installUpdate, setAutoUpdate }
}

/** The shell's state, live. */
function useShellState(): { bridge: Bridge | null; updater: ReturnType<typeof updaterOf>; shell: ShellUpdateState | null } {
  const bridge = readBridge()
  const updater = updaterOf(bridge)
  const [shell, setShell] = useState<ShellUpdateState | null>(null)
  useEffect(() => {
    if (!updater) return
    let alive = true
    let unsubscribe: (() => void) | null = null
    try {
      unsubscribe = updater.onUpdateState((state) => {
        if (alive) setShell(parseShellState(state))
      })
      void updater
        .getUpdateState()
        .then((state) => {
          if (alive) setShell((current) => current ?? parseShellState(state))
        })
        .catch(() => undefined)
    } catch {
      // The bridge went away with the window.
    }
    return () => {
      alive = false
      try {
        unsubscribe?.()
      } catch {
        // ignore
      }
    }
  }, [])
  return { bridge, updater, shell }
}

// `/api/downloads`: the newest DESKTOP release, kept fresh while the app is open (§4a).
const releaseWatch = new ReleaseWatch({
  fetchRelease: () =>
    fetch('/api/downloads', { headers: { Accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : null))
      .then((json: unknown) => parseRelease(json)),
  now: () => Date.now(),
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
})

function useRelease(enabled: boolean): DesktopRelease | null {
  const [release, setRelease] = useState<DesktopRelease | null>(releaseWatch.current)
  useEffect(() => {
    if (!enabled) return
    const unsubscribe = releaseWatch.subscribe(setRelease)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void releaseWatch.refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled])
  return release
}

/** In-memory twin of the stored hint record (private mode, or storage that throws). */
let lastHint: HintRecord | null = null

/**
 * §4a: a newer desktop release than this app, and a shell that has not seen
 * it yet: ask the shell to look now (once per version per ten minutes). The
 * shell reads its own pinned feed; with automatic download on (the default)
 * it also downloads, during a call too, and never restarts by itself.
 */
function useUpdateHint(
  bridge: Bridge | null,
  updater: ReturnType<typeof updaterOf>,
  shell: ShellUpdateState | null,
  release: DesktopRelease | null,
): void {
  const appVersion = bridge?.appVersion
  useEffect(() => {
    if (!updater) return
    const now = Date.now()
    const stored = loadHint()
    const last = [stored, lastHint].filter((r): r is HintRecord => r !== null).sort((a, b) => b.at - a.at)[0] ?? null
    if (!shouldAskShell({ appVersion, hasUpdater: true, shell, release, last, now })) return
    if (!release) return
    lastHint = { version: release.version, at: now }
    saveHint(lastHint)
    try {
      void updater.checkForUpdates().catch(() => undefined)
    } catch {
      // The bridge went away with the window.
    }
  // `release` is a new object after every successful poll, so a shell that found
  // nothing yet is asked again once the ten minutes are over.
  }, [updater, appVersion, shell?.status, shell?.version, shell?.capability, release])
}

function useNotice(): {
  bridge: Bridge | null
  updater: ReturnType<typeof updaterOf>
  shell: ShellUpdateState | null
  notice: DesktopNotice | null
  release: DesktopRelease | null
} {
  const { bridge, updater, shell } = useShellState()
  const release = useRelease(bridge !== null)
  useUpdateHint(bridge, updater, shell, release)
  const notice = desktopNotice({
    isDesktop: bridge !== null,
    appVersion: bridge?.appVersion,
    hasUpdater: updater !== null,
    shell,
    release,
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
  })
  return { bridge, updater, shell, notice, release }
}

/** Direct download(s) of this machine's installer; each opens in the system browser (the app's window-open guard). */
function Downloads({ downloads, testId }: { downloads: DownloadButton[]; testId: string }) {
  if (downloads.length === 0) {
    return (
      <a href={DESKTOP_RELEASES_URL} target="_blank" rel="noopener noreferrer" data-testid={testId} data-platform="page">
        İndir
      </a>
    )
  }
  return (
    <>
      {downloads.map((d) => (
        <a
          key={d.platform}
          href={d.url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={testId}
          data-platform={d.platform}
        >
          {d.label}
        </a>
      ))}
    </>
  )
}

/** Ayarlar › Hakkında, in the desktop app: the app's version and its update state. */
export function DesktopVersionFooter(_props: { serverVersion?: string | null }) {
  const { bridge, updater, shell, notice } = useNotice()
  const [busy, setBusy] = useState(false)
  if (!bridge) return null
  const auto = updater && shell?.capability === 'auto' ? shell : null
  const working = auto ? ['checking', 'downloading', 'installing'].includes(auto.status) : false
  const run = (action: () => Promise<unknown>) => {
    setBusy(true)
    void action()
      .catch(() => undefined)
      .finally(() => setBusy(false))
  }
  return (
    <footer className="settings-versions desktop-version" data-testid="desktop-update-settings">
      <span data-testid="desktop-version">{desktopLine(bridge.appVersion)}</span>
      {auto && updater && (
        <>
          <span className="desktop-update-status" data-testid="desktop-update-status" data-status={auto.status}>
            {statusText(auto)}
          </span>
          <span className="desktop-update-actions">
            {auto.status === 'ready' && (
              <button
                type="button"
                className="primary"
                data-testid="desktop-update-install-settings"
                disabled={auto.inVoice}
                title={auto.inVoice ? 'Sesli odadan çıkınca yeniden başlatabilirsin' : undefined}
                onClick={() => run(() => updater.installUpdate())}
              >
                Yeniden başlat ve güncelle
              </button>
            )}
            {(auto.status === 'available' || (auto.status === 'error' && auto.version)) && (
              <button
                type="button"
                className="ghost"
                data-testid="desktop-update-fetch-settings"
                onClick={() => run(() => updater.downloadUpdate())}
              >
                İndir
              </button>
            )}
            <button
              type="button"
              className="ghost"
              data-testid="desktop-update-check"
              disabled={busy || working}
              onClick={() => run(() => updater.checkForUpdates())}
            >
              Güncellemeleri denetle
            </button>
          </span>
          {auto.status === 'ready' && auto.inVoice && (
            <small className="settings-hint" data-testid="desktop-update-in-voice">
              Görüşmedeyken yeniden başlatılmaz; sesli odadan çıkınca kurabilirsin. Uygulamadan çıkarsan da kurulur.
            </small>
          )}
          <label className="settings-toggle">
            <input
              type="checkbox"
              data-testid="desktop-update-auto"
              checked={auto.autoDownload}
              onChange={(event) => updater.setAutoUpdate(event.target.checked)}
            />
            <span>Güncellemeleri kendiliğinden indir</span>
          </label>
        </>
      )}
      {updater && shell?.capability === 'manual' && statusText(shell) && (
        <span className="desktop-update-status" data-testid="desktop-update-reason" data-reason={shell.reason ?? ''}>
          {statusText(shell)}
        </span>
      )}
      {notice?.kind === 'manual' && (
        <span className="desktop-update-line" data-testid="desktop-update-line">
          {updateText(notice.version)} {notice.lastManual && <>{LAST_MANUAL_TEXT} </>}
          <Downloads downloads={notice.downloads} testId="desktop-update-line-download" />
        </span>
      )}
    </footer>
  )
}

/** "Sonra" on a ready update: hidden until the page loads again (the app restarts on its own only on quit). */
let laterVersion: string | null = null

/** A dot on the settings button while the shell has an update to show (§5). */
export function DesktopUpdateDot() {
  const { shell } = useShellState()
  if (!shell || shell.capability !== 'auto' || !shell.version) return null
  if (!['available', 'downloading', 'ready'].includes(shell.status)) return null
  return (
    <span
      className="ops-dot update-dot"
      data-testid="desktop-update-dot"
      data-status={shell.status}
      aria-label="Masaüstü güncellemesi"
      title={shell.status === 'ready' ? `Güncelleme hazır: ${shell.version}` : `Güncelleme: ${shell.version}`}
    />
  )
}

/** The band in the app. */
export function DesktopUpdateBand({ ready }: { serverVersion?: string | null; ready: boolean }) {
  const { updater, notice } = useNotice()
  const [dismissed, setDismissed] = useState(loadDismissed)
  const [later, setLater] = useState(laterVersion)
  const [laterPre, setLaterPre] = useState(loadLater)
  // Every (re)connect asks for the newest release again (a release published
  // while the socket was down, or a server that restarted for a deploy).
  useEffect(() => {
    if (ready) void releaseWatch.refresh(true)
  }, [ready])
  if (!ready || !notice) return null

  if (notice.kind === 'manual') {
    if (dismissed === notice.version) return null
    const version = notice.version
    return (
      <div className="desktop-update-band" role="status" data-testid="desktop-update" data-kind="manual" data-version={version}>
        <span>
          {updateText(version)} {notice.lastManual && <strong data-testid="desktop-update-last">{LAST_MANUAL_TEXT}</strong>}{' '}
          <Downloads downloads={notice.downloads} testId="desktop-update-download" />
        </span>
        <button
          type="button"
          className="icon-button small"
          data-testid="desktop-update-dismiss"
          aria-label="Kapat"
          title="Bu sürüm için gösterme"
          onClick={() => {
            saveDismissed(version)
            setDismissed(version)
          }}
        >
          <CloseIcon size={14} />
        </button>
      </div>
    )
  }

  if (!updater) return null
  const pre = notice.kind === 'available' || notice.kind === 'downloading'
  if (pre ? laterPre === notice.version : later === notice.version) return null
  const hide = () => {
    if (pre) {
      saveLater(notice.version)
      setLaterPre(notice.version)
    } else {
      laterVersion = notice.version
      setLater(notice.version)
    }
  }
  const laterButton = (
    <button type="button" className="ghost" data-testid="desktop-update-later" onClick={hide}>
      Sonra
    </button>
  )

  return (
    <div
      className="desktop-update-band"
      role="status"
      data-testid="desktop-update"
      data-kind={notice.kind}
      data-version={notice.version}
      data-in-voice={notice.inVoice}
    >
      <span>{bandText(notice)}</span>
      <span className="desktop-update-actions">
        {notice.kind === 'available' && (
          <button
            type="button"
            className="primary"
            data-testid="desktop-update-fetch"
            onClick={() => void updater.downloadUpdate().catch(() => undefined)}
          >
            İndir
          </button>
        )}
        {notice.kind === 'ready' && !notice.inVoice && (
          <button
            type="button"
            className="primary"
            data-testid="desktop-update-install"
            onClick={() => void updater.installUpdate().catch(() => undefined)}
          >
            Yeniden başlat ve güncelle
          </button>
        )}
        {laterButton}
      </span>
    </div>
  )
}
