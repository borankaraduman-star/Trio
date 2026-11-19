import { useState, useSyncExternalStore } from 'react'
import { dismissInstall, installDismissed, installMode, installPrompt } from '../../lib/notify/install'
import { notifyHub } from '../../lib/notify/notifyHub'

function ShareGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" className="install-glyph">
      <path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M5 11v8.5h14V11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** "Ana ekrana ekle": once, dismissible, remembered (lib/notify/install.ts). */
export function InstallCard() {
  const promptReady = useSyncExternalStore(installPrompt.subscribe, installPrompt.ready)
  const notify = useSyncExternalStore(notifyHub.subscribe, notifyHub.getSnapshot)
  const [dismissed, setDismissed] = useState(installDismissed)
  const mode = installMode({ ios: notify.env.ios, standalone: notify.env.standalone, promptReady, dismissed })
  if (!mode) return null
  const close = () => {
    dismissInstall()
    setDismissed(true)
  }
  return (
    <aside className="install-card" role="dialog" aria-labelledby="install-card-title" data-testid="install-card" data-mode={mode}>
      <div className="install-card-head">
        <img src="/icon-192.png" alt="" width={40} height={40} />
        <h2 id="install-card-title">Trio’yu ana ekrana ekle</h2>
      </div>
      {mode === 'ios' ? (
        <>
          <p>
            iPhone’da bildirimler yalnızca ana ekrandan açılan Trio’ya gelir. İki dokunuş yeter:
          </p>
          <ol className="install-steps">
            <li>
              Safari’de <strong>Paylaş</strong> <ShareGlyph /> düğmesine dokun.
            </li>
            <li>
              <strong>Ana Ekrana Ekle</strong>’yi seç, sonra <strong>Ekle</strong>.
            </li>
            <li>Trio’yu ana ekrandan aç ve Ayarlar › Bildirimler’den izin ver.</li>
          </ol>
          <div className="install-actions">
            <button type="button" className="primary" data-testid="install-card-ok" onClick={close}>
              Anladım
            </button>
          </div>
        </>
      ) : (
        <>
          <p>Uygulama gibi açılır, kendi simgesi olur; bildirimler de daha güvenilir gelir.</p>
          <div className="install-actions">
            <button type="button" className="ghost" data-testid="install-card-later" onClick={close}>
              Şimdi değil
            </button>
            <button
              type="button"
              className="primary"
              data-testid="install-card-install"
              onClick={() => {
                void installPrompt.show().then(close)
              }}
            >
              Ekle
            </button>
          </div>
        </>
      )}
    </aside>
  )
}
