import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react'
import { pastedFileName } from '../lib/attachments'
import { checkLength, MAX_MESSAGE_LENGTH, tooLongMessage } from '../lib/messageLength'
import './composer-length.css'
import type { PendingAttachment } from '../lib/pending'
import { PendingAttachments } from './Attachments'
import { PaperclipIcon } from './icons2'
import { VoiceRecordButton } from './media/VoiceRecordButton'
import type { Recording } from '../lib/voiceRecorder'

/** v2: the composer's attachment side (CONTRACT-V2 §2). */
export interface ComposerAttachments {
  items: readonly PendingAttachment[]
  files: ReadonlyMap<string, File>
  /** At least one uploaded attachment would go with the message. */
  ready: boolean
  uploading: boolean
  /** A chip failed: the message is held until it is removed, so no file is silently left out. */
  failed?: boolean
  notice: string | null
  onAdd: (files: File[]) => void
  onRemove: (localId: string) => void
  onDismissNotice: () => void
  /** V6: "Orijinali gönder" (per device). */
  sendOriginal?: boolean
  onToggleOriginal?: (value: boolean) => void
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

export { MAX_MESSAGE_LENGTH }

export function Composer({
  channelName,
  onSend,
  onTyping,
  attachments,
  onDraftChange,
  replyBar,
  onEscape,
  onEditLast,
  focusSignal,
  initialText = '',
  onTextChange,
  voice,
}: {
  channelName: string
  onSend: (content: string) => void
  onTyping: () => void
  attachments?: ComposerAttachments
  /** Whether the box holds unsent text (false again when it is sent, emptied or unmounted). */
  onDraftChange?: (hasDraft: boolean) => void
  /** v4: the "replying to" strip shown above the box. */
  replyBar?: ReactNode
  /** v4: Esc in the box (lets a reply go); true when it did something. */
  onEscape?: () => boolean
  /** v4: up-arrow in an EMPTY box: edit my last message; true when there is one. */
  onEditLast?: () => boolean
  /** v4: a change of this number moves the focus into the box. */
  focusSignal?: number
  /** V6: the channel's saved draft (lib/drafts.ts). */
  initialText?: string
  /** V6: every change of the text, for the draft. */
  onTextChange?: (text: string) => void
  /** V6: voice messages; the microphone shows while the box is empty. */
  voice?: { onRecorded: (recording: Recording) => void; onError: (message: string) => void }
}) {
  const [text, setText] = useState(initialText)
  const [recording, setRecording] = useState(false)
  const textReport = useRef(onTextChange)
  textReport.current = onTextChange
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  // v2: content may be empty when an uploaded attachment goes with it; nothing
  // is sent while an upload is still running (it would be left behind).
  const uploading = attachments?.uploading ?? false
  const failed = attachments?.failed ?? false
  // Counted as the server counts it; never truncated (lib/messageLength.ts).
  const length = checkLength(text)
  const canSend =
    !uploading &&
    !failed &&
    length.over === 0 &&
    (length.content !== '' || (attachments?.ready ?? false))

  const hasDraft = text.trim() !== ''
  const draftReport = useRef(onDraftChange)
  draftReport.current = onDraftChange
  useEffect(() => {
    draftReport.current?.(hasDraft)
  }, [hasDraft])
  useEffect(
    () => () => {
      draftReport.current?.(false)
    },
    [],
  )

  useEffect(() => {
    if (focusSignal) ref.current?.focus({ preventScroll: true })
  }, [focusSignal])

  // Grow with the text, up to the CSS max-height.
  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [text])

  const send = () => {
    const content = length.content
    if (!canSend) return
    onSend(content)
    setText('')
    textReport.current?.('')
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
    } else if (event.key === 'Escape' && onEscape?.()) {
      event.preventDefault()
    } else if (
      event.key === 'ArrowUp' &&
      text === '' &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      onEditLast?.()
    ) {
      event.preventDefault()
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
      {length.showCounter && (
        <div className={`composer-length${length.over > 0 ? ' over' : ''}`} data-testid="composer-length">
          {length.over > 0 && <span role="alert">{tooLongMessage(length.over)}</span>}
          <span className="composer-length-count">
            {length.length} / {MAX_MESSAGE_LENGTH}
          </span>
        </div>
      )}
      {replyBar}
      {attachments && (
        <PendingAttachments
          items={attachments.items}
          files={attachments.files}
          onRemove={attachments.onRemove}
          sendOriginal={attachments.sendOriginal}
          onToggleOriginal={attachments.onToggleOriginal}
        />
      )}
    <div className={`composer${recording ? ' recording' : ''}`}>
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
        aria-invalid={length.over > 0}
        placeholder={`Mesaj yaz… (#${channelName})`}
        aria-label="Mesaj yaz"
        onChange={(event) => {
          setText(event.target.value)
          textReport.current?.(event.target.value)
          if (event.target.value.trim()) onTyping()
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      {voice && (text === '' || recording) && (
        <VoiceRecordButton onRecorded={voice.onRecorded} onError={voice.onError} onActiveChange={setRecording} />
      )}
      <button
        type="button"
        className="primary"
        data-testid="composer-send"
        disabled={!canSend}
        title={
          uploading
            ? 'Dosyalar yükleniyor…'
            : failed
              ? 'Önce yüklenemeyen dosyayı kaldır'
              : length.over > 0
                ? tooLongMessage(length.over)
                : undefined
        }
        onClick={send}
      >
        Gönder
      </button>
    </div>
    </div>
  )
}
