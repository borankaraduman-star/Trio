import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { pastedFileName } from '../lib/attachments'
import type { PendingAttachment } from '../lib/pending'
import { PendingAttachments } from './Attachments'
import { PaperclipIcon } from './icons2'

/** v2: the composer's attachment side (CONTRACT-V2 §2). */
export interface ComposerAttachments {
  items: readonly PendingAttachment[]
  files: ReadonlyMap<string, File>
  /** At least one uploaded attachment would go with the message. */
  ready: boolean
  uploading: boolean
  notice: string | null
  onAdd: (files: File[]) => void
  onRemove: (localId: string) => void
  onDismissNotice: () => void
}

/** Clipboard files, with a timestamped name for the nameless ones (screenshots). */
function clipboardFiles(event: ClipboardEvent): File[] {
  const result: File[] = []
  const now = new Date()
  for (const file of Array.from(event.clipboardData?.files ?? [])) {
    const generic = !file.name || /^image\.(png|jpe?g|gif|webp)$/i.test(file.name)
    result.push(generic ? new File([file], pastedFileName(file.type, now), { type: file.type }) : file)
  }
  return result
}

export const MAX_MESSAGE_LENGTH = 4000

export function Composer({
  channelName,
  onSend,
  onTyping,
  attachments,
}: {
  channelName: string
  onSend: (content: string) => void
  onTyping: () => void
  attachments?: ComposerAttachments
}) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  // v2: content may be empty when an uploaded attachment goes with it; nothing
  // is sent while an upload is still running (it would be left behind).
  const uploading = attachments?.uploading ?? false
  const canSend = !uploading && (text.trim() !== '' || (attachments?.ready ?? false))

  // Grow with the text, up to the CSS max-height.
  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [text])

  const send = () => {
    const content = text.trim()
    if (!canSend) return
    onSend(content)
    setText('')
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!attachments) return
    const files = clipboardFiles(event)
    if (files.length === 0) return
    // A copied image often comes with its HTML too; text that is real text still pastes.
    if (!event.clipboardData.types.includes('text/plain')) event.preventDefault()
    attachments.onAdd(files)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter confirms an IME composition (Japanese, Korean…) and must not send then.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      send()
    }
  }

  return (
    <div className="composer-wrap">
      {attachments?.notice && (
        <div className="composer-notice" role="alert" data-testid="attachment-notice">
          <span>{attachments.notice}</span>
          <button type="button" className="link" onClick={attachments.onDismissNotice}>
            Tamam
          </button>
        </div>
      )}
      {attachments && (
        <PendingAttachments items={attachments.items} files={attachments.files} onRemove={attachments.onRemove} />
      )}
    <div className="composer">
      {attachments && (
        <>
          <button
            type="button"
            className="icon-button attach-button"
            data-testid="btn-attach"
            title="Dosya ekle"
            aria-label="Dosya ekle"
            onClick={() => fileInput.current?.click()}
          >
            <PaperclipIcon />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            data-testid="file-input"
            tabIndex={-1}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              // Reset, so choosing the same file again fires `change` again.
              event.target.value = ''
              attachments.onAdd(files)
              ref.current?.focus()
            }}
          />
        </>
      )}
      <textarea
        ref={ref}
        data-testid="composer"
        rows={1}
        value={text}
        maxLength={MAX_MESSAGE_LENGTH}
        placeholder={`Mesaj yaz… (#${channelName})`}
        aria-label="Mesaj yaz"
        onChange={(event) => {
          setText(event.target.value)
          if (event.target.value.trim()) onTyping()
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <button
        type="button"
        className="primary"
        data-testid="composer-send"
        disabled={!canSend}
        title={uploading ? 'Dosyalar yükleniyor…' : undefined}
        onClick={send}
      >
        Gönder
      </button>
    </div>
    </div>
  )
}
