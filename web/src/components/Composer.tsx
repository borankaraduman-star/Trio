import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react'
import { pastedFileName } from '../lib/attachments'
import { checkLength, MAX_MESSAGE_LENGTH, tooLongMessage } from '../lib/messageLength'
import './composer-length.css'
import type { PendingAttachment } from '../lib/pending'
import { PendingAttachments } from './Attachments'
import { PaperclipIcon } from './icons2'
import { VoiceRecordButton } from './media/VoiceRecordButton'
import type { Recording } from '../lib/voiceRecorder'
import { enterSends, focusWouldInterrupt, isTouchFirst } from '../lib/touchInput'
import { filterMentionNames, mentionQueryAt } from '../lib/groups'
import { Avatar } from './Avatar'

/** V10: a person the "@" list can offer. */
export interface MentionPerson {
  id: number
  name: string
  avatar_url?: string | null
}

/** V10: "@herkes" as a row of the list (id 0: no user has it). */
const EVERYONE_ROW: MentionPerson = { id: 0, name: 'herkes' }

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
  focusOnMount = false,
  mentionPeople,
}: {
  /** V10 (CONTRACT-V10-GROUPS §3): the people "@" offers, filtered as one types. */
  mentionPeople?: readonly MentionPerson[]
  /** V7-READING §5: the channel was switched to on purpose: take the focus (never on touch). */
  focusOnMount?: boolean
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
  // V10: the "@" list: where the caret is, which row is chosen, and an "@" closed with Esc.
  const [caret, setCaret] = useState<number | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionClosedAt, setMentionClosedAt] = useState<number | null>(null)
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

  // V7-READING: read once per mount; a phone rotating does not change its keyboard.
  const [touchFirst] = useState(isTouchFirst)
  useEffect(() => {
    if (!focusOnMount || touchFirst || focusWouldInterrupt(document)) return
    ref.current?.focus({ preventScroll: true })
    // Only when the composer mounts (each channel has its own).
  }, [])

  // Grow with the text, up to the CSS max-height.
  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [text])

  const mention = mentionPeople && caret !== null ? mentionQueryAt(text, caret) : null
  const mentionOptions =
    mention && mention.start !== mentionClosedAt
      ? filterMentionNames([...(mentionPeople ?? []), EVERYONE_ROW], mention.query, 8)
      : []
  const mentionOpen = mentionOptions.length > 0
  const chosen = Math.min(mentionIndex, Math.max(0, mentionOptions.length - 1))

  const pickMention = (person: MentionPerson) => {
    const element = ref.current
    if (!mention || !element) return
    const end = caret ?? text.length
    const inserted = `@${person.name} `
    const next = text.slice(0, mention.start) + inserted + text.slice(end)
    const position = mention.start + inserted.length
    setText(next)
    textReport.current?.(next)
    setMentionIndex(0)
    setCaret(position)
    requestAnimationFrame(() => {
      element.focus()
      element.setSelectionRange(position, position)
    })
  }

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
    if (mentionOpen && !event.nativeEvent.isComposing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setMentionIndex((chosen + step + mentionOptions.length) % mentionOptions.length)
        return
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault()
        pickMention(mentionOptions[chosen])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMentionClosedAt(mention?.start ?? null)
        return
      }
    }
    // Enter confirms an IME composition (Japanese, Korean…) and must not send then.
    // V7-READING §4: on a touch-first device Enter is the newline key.
    if (
      enterSends(
        {
          key: event.key,
          shiftKey: event.shiftKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          isComposing: event.nativeEvent.isComposing,
        },
        touchFirst,
      )
    ) {
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
      {mentionOpen && (
        <ul className="mention-list" role="listbox" id="mention-list" aria-label="Bahsedilecek kişi" data-testid="mention-list">
          {mentionOptions.map((person, index) => (
            <li
              key={person.id}
              role="option"
              id={`mention-option-${person.id}`}
              aria-selected={index === chosen}
              className={index === chosen ? 'mention-option chosen' : 'mention-option'}
              data-testid={`mention-option-${person.id}`}
              // Before the textarea's blur: the click must not lose the caret.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pickMention(person)}
              onMouseEnter={() => setMentionIndex(index)}
            >
              {person.id === 0 ? (
                <span className="mention-everyone" aria-hidden="true">@</span>
              ) : (
                <Avatar id={person.id} name={person.name} size={22} url={person.avatar_url} />
              )}
              <span className="mention-name">{person.name}</span>
              {person.id === 0 && <small>herkese bildirim</small>}
            </li>
          ))}
        </ul>
      )}
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
        aria-autocomplete={mentionPeople ? 'list' : undefined}
        aria-controls={mentionOpen ? 'mention-list' : undefined}
        aria-activedescendant={mentionOpen ? `mention-option-${mentionOptions[chosen].id}` : undefined}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onBlur={() => setCaret(null)}
        enterKeyHint={touchFirst ? 'enter' : 'send'}
        data-enter={touchFirst ? 'newline' : 'send'}
        onChange={(event) => {
          setText(event.target.value)
          setCaret(event.target.selectionStart)
          setMentionIndex(0)
          if (mentionClosedAt !== null && event.target.value[mentionClosedAt] !== '@') setMentionClosedAt(null)
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
