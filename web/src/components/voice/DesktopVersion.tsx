import { useState } from 'react'
import {
  DESKTOP_RELEASES_URL,
  desktopVersionState,
  loadDismissed,
  saveDismissed,
  updateText,
} from '../../lib/desktopVersion'
import { CLIENT_VERSION } from '../../lib/version'
import { CloseIcon } from '../icons2'

function bridgeFacts(): { isDesktop: boolean; appVersion: unknown } {
  const bridge = (globalThis as { trioDesktop?: { isDesktop?: unknown; appVersion?: unknown } }).trioDesktop
  return { isDesktop: bridge?.isDesktop === true, appVersion: bridge?.appVersion }
}

/** "İndir": a new window, which the desktop app opens in the system browser (its window-open guard). */
function Download() {
  return (
    <a href={DESKTOP_RELEASES_URL} target="_blank" rel="noopener noreferrer" data-testid="desktop-update-download">
      İndir
    </a>
  )
}

/** Ayarlar's footer, in the desktop app: the app's version, and the update line. */
export function DesktopVersionFooter({ serverVersion }: { serverVersion: string | null }) {
  const state = desktopVersionState({ ...bridgeFacts(), serverVersion, clientVersion: CLIENT_VERSION })
  if (!state) return null
  return (
    <footer className="settings-versions desktop-version">
      <span data-testid="desktop-version">{state.line}</span>
      {state.update && (
        <span className="desktop-update-line" data-testid="desktop-update-line">
          {updateText(state.update)} <Download />
        </span>
      )}
    </footer>
  )
}

/** The band in the app: until dismissed for that version. */
export function DesktopUpdateBand({ serverVersion, ready }: { serverVersion: string | null; ready: boolean }) {
  const [dismissed, setDismissed] = useState(loadDismissed)
  if (!ready) return null
  const state = desktopVersionState({ ...bridgeFacts(), serverVersion, clientVersion: CLIENT_VERSION })
  if (!state?.update || dismissed === state.update) return null
  const version = state.update
  return (
    <div className="desktop-update-band" role="status" data-testid="desktop-update" data-version={version}>
      <span>
        {updateText(version)} <Download />
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
