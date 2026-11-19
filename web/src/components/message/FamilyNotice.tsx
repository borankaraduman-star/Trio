/** A quiet, short-lived notice for a refused change (a limit, a rate limit). */
export function FamilyNotice({ text, onDismiss }: { text: string | null; onDismiss: () => void }) {
  if (!text) return null
  return (
    <div className="msg-notice" role="status" data-testid="message-notice">
      <span>{text}</span>
      <button type="button" className="link" onClick={onDismiss}>
        Tamam
      </button>
    </div>
  )
}
