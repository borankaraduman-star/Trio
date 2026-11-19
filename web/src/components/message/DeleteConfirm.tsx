import { useRef } from 'react'
import type { Message } from '../../types'
import { useFocusTrap } from './useFocusTrap'

/** "Delete this message?" — asked once; says that its files go too. */
export function DeleteConfirm({ message, onConfirm, onCancel }: { message: Message; onConfirm: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  useFocusTrap(ref, onCancel, { initial: cancel })
  const files = message.attachments?.length ?? 0
  return (
    <div className="modal-backdrop">
      <div
        ref={ref}
        className="modal msg-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="msg-delete-title"
        aria-describedby="msg-delete-body"
        data-testid="delete-confirm"
      >
        <header className="modal-header">
          <h2 id="msg-delete-title">Mesaj silinsin mi?</h2>
        </header>
        <div id="msg-delete-body" className="msg-delete-body">
          {message.content !== '' && <blockquote>{[...message.content].slice(0, 200).join('')}</blockquote>}
          <p>
            Mesaj herkes için silinir; geri alınamaz.
            {files > 0 && (
              <>
                {' '}
                Ekli {files === 1 ? 'dosya' : `${files} dosya`} da sunucudan silinir.
              </>
            )}
          </p>
        </div>
        <footer className="msg-delete-actions">
          <button type="button" className="danger" data-testid="delete-confirm-yes" onClick={onConfirm}>
            Sil
          </button>
          <button ref={cancel} type="button" className="ghost" data-testid="delete-confirm-no" onClick={onCancel}>
            Vazgeç
          </button>
        </footer>
      </div>
    </div>
  )
}
