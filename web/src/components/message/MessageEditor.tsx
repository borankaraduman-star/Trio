import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { checkLength, MAX_MESSAGE_LENGTH, tooLongMessage } from '../../lib/messageLength'

/**
 * Editing a message in place: Enter saves, Shift+Enter is a new line, Esc
 * cancels. The same length rule as the composer; the text may only become
 * empty while the message keeps attachments.
 */
export function MessageEditor({
  initial,
  hasAttachments,
  onSave,
  onCancel,
}: {
  initial: string
  hasAttachments: boolean
  onSave: (content: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)
  const length = checkLength(text)
  const empty = length.content === '' && !hasAttachments
  const invalid = length.over > 0 || empty

  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.focus({ preventScroll: true })
    element.setSelectionRange(element.value.length, element.value.length)
  }, [])
  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [text])

  const save = () => {
    if (!invalid) onSave(length.content)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      save()
    }
  }

  return (
    <div className="msg-editor" data-testid="message-editor">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        aria-label="Mesajı düzenle"
        aria-invalid={invalid}
        data-testid="message-editor-input"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="msg-editor-hint">
        {length.over > 0 ? (
          <span className="msg-editor-error" role="alert">
            {tooLongMessage(length.over)}
          </span>
        ) : empty ? (
          <span className="msg-editor-error" role="alert">
            Mesaj boş olamaz: silmek için Sil'i kullan.
          </span>
        ) : (
          <span>
            Kaydetmek için <kbd>Enter</kbd>, vazgeçmek için <kbd>Esc</kbd>
            {length.showCounter && ` · ${length.length} / ${MAX_MESSAGE_LENGTH}`}
          </span>
        )}
        <span className="msg-editor-buttons">
          <button type="button" className="link" onClick={onCancel} data-testid="message-editor-cancel">
            Vazgeç
          </button>
          <button type="button" className="link" onClick={save} disabled={invalid} data-testid="message-editor-save">
            Kaydet
          </button>
        </span>
      </div>
    </div>
  )
}
