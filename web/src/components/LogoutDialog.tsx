import { useEffect, useRef } from 'react'
import { CloseIcon } from './icons2'

/**
 * "Sign out of this device?" — says plainly what happens (CONTRACT-V3 §2, §3):
 * only this device's token ends; the account, the name and the messages stay.
 * Coming back as the same person needs a device code, which only a device
 * that is still signed in (or the server's admin tool) can make. The client
 * cannot know whether this is the last signed-in device, so making a code
 * first is offered every time, as the safe choice.
 */
export function LogoutDialog({
  name,
  busy,
  onCancel,
  onConfirm,
  onCreateCodeFirst,
}: {
  name: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
  onCreateCodeFirst: () => void
}) {
  const safe = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    safe.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
  }, [busy, onCancel])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <div
        className="modal logout-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="logout-title"
        aria-describedby="logout-body"
        data-testid="logout-dialog"
      >
        <header className="modal-header">
          <h2 id="logout-title">Bu cihazdan çıkış yapılsın mı?</h2>
          <button type="button" className="icon-button" aria-label="Vazgeç" title="Vazgeç (Esc)" onClick={onCancel} disabled={busy}>
            <CloseIcon />
          </button>
        </header>
        <div id="logout-body" className="logout-body">
          <p>
            Yalnızca <strong>bu cihazdaki oturum</strong> kapanır. Hesabın, adın (<strong>{name}</strong>) ve
            mesajların silinmez; başka cihazlarında açık oturumların da açık kalır.
          </p>
          <p>
            Geri dönmek için giriş yaptığın <strong>başka bir cihazdan cihaz kodu</strong> alman gerekir (Ayarlar ›
            Hesap › Cihaz ekle). Davet koduyla aynı adla yeniden katılamazsın: ad hesabına ait kalır.
          </p>
          <p className="logout-warning">
            Başka bir cihazda giriş yapmadıysan, bu hesaba ancak sunucuyu yöneten kişi sana bir cihaz kodu üretirse
            dönebilirsin; yoksa davet koduyla <strong>farklı bir adla yeni bir hesap</strong> açman gerekir. Bu yüzden
            önce bir cihaz kodu oluştur: 10 dakika içinde bu cihazda ya da başka bir cihazda girmek için kullanabilirsin.
          </p>
        </div>
        <footer className="logout-actions">
          <button
            ref={safe}
            type="button"
            className="primary"
            data-testid="logout-code-first"
            onClick={onCreateCodeFirst}
            disabled={busy}
          >
            Önce cihaz kodu oluştur
          </button>
          <button type="button" className="danger" data-testid="logout-confirm" onClick={onConfirm} disabled={busy}>
            {busy ? 'Çıkış yapılıyor…' : 'Çıkış yap'}
          </button>
          <button type="button" className="ghost" data-testid="logout-cancel" onClick={onCancel} disabled={busy}>
            Vazgeç
          </button>
        </footer>
      </div>
    </div>
  )
}
