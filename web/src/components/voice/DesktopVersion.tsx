import { useEffect, useState } from 'react'
import {
  DESKTOP_RELEASES_URL,
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

// `/api/downloads`: the newest DESKTOP release. Asked at most every 10 minutes per page.
let releaseCache: { at: number; promise: Promise<DesktopRelease | null> } | null = null
const RELEASE_TTL_MS = 10 * 60 * 1000

function fetchRelease(): Promise<DesktopRelease | null> {
  const now = Date.now()
  if (releaseCache && now - releaseCache.at < RELEASE_TTL_MS) return releaseCache.promise
  const promise = fetch('/api/downloads', { headers: { Accept: 'application/json' } })
    .then((response) => (response.ok ? response.json() : null))
    .then((json: unknown) => parseRelease(json))
    .catch(() => null)
  releaseCache = { at: now, promise }
  return promise
}

function useRelease(enabled: boolean): DesktopRelease | null {
  const [release, setRelease] = useState<DesktopRelease | null>(null)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    void fetchRelease().then((value) => {
      if (alive) setRelease(value)
    })
    return () => {
      alive = false
    }
  }, [enabled])
  return release
}

function useNotice(): {
  bridge: Bridge | null
  updater: ReturnType<typeof updaterOf>
  shell: ShellUpdateState | null
  notice: DesktopNotice | null
} {
  const { bridge, updater, shell } = useShellState()
  const release = useRelease(bridge !== null)
  const notice = desktopNotice({
    isDesktop: bridge !== null,
    appVersion: bridge?.appVersion,
    hasUpdater: updater !== null,
    shell,
    release,
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
  })
  return { bridge, updater, shell, notice }
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

/** The band in the app. */
export function DesktopUpdateBand({ ready }: { serverVersion?: string | null; ready: boolean }) {
  const { updater, notice } = useNotice()
  const [dismissed, setDismissed] = useState(loadDismissed)
  const [later, setLater] = useState(laterVersion)
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

  if (notice.kind === 'downloading' || !updater || later === notice.version) return null
  const hide = () => {
    laterVersion = notice.version
    setLater(notice.version)
  }
  const laterButton = (
    <button type="button" className="ghost" data-testid="desktop-update-later" onClick={hide}>
      Sonra
    </button>
  )

  if (notice.kind === 'available') {
    return (
      <div className="desktop-update-band" role="status" data-testid="desktop-update" data-kind="available" data-version={notice.version}>
        <span>{updateText(notice.version)}</span>
        <span className="desktop-update-actions">
          <button
            type="button"
            className="primary"
            data-testid="desktop-update-fetch"
            onClick={() => void updater.downloadUpdate().catch(() => undefined)}
          >
            İndir
          </button>
          {laterButton}
        </span>
      </div>
    )
  }

  return (
    <div
      className="desktop-update-band"
      role="status"
      data-testid="desktop-update"
      data-kind="ready"
      data-version={notice.version}
      data-in-voice={notice.inVoice}
    >
      <span>
        Güncelleme hazır: {notice.version}
        {notice.inVoice && ' — sesli odadan çıkınca yeniden başlatabilirsin'}
      </span>
      <span className="desktop-update-actions">
        {!notice.inVoice && (
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
