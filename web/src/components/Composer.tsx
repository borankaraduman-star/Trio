import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

export const MAX_MESSAGE_LENGTH = 4000

export function Composer({
  channelName,
  onSend,
  onTyping,
}: {
  channelName: string
  onSend: (content: string) => void
  onTyping: () => void
}) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  // Grow with the text, up to the CSS max-height.
  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [text])

  const send = () => {
    const content = text.trim()
    if (!content) return
    onSend(content)
    setText('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter confirms an IME composition (Japanese, Korean…) and must not send then.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      send()
    }
  }

  return (
    <div className="composer">
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
      />
      <button
        type="button"
        className="primary"
        data-testid="composer-send"
        disabled={!text.trim()}
        onClick={send}
      >
        Gönder
      </button>
    </div>
  )
}
