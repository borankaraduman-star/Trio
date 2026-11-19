import { useEffect, useRef, useState } from 'react'

/**
 * Asks for the invite code before a destructive owner action
 * (CONTRACT-V6-OPS §2). The code is never stored or prefilled: a stolen token
 * alone must not be enough to remove somebody.
 */
export function ConfirmCodeDialog({
  title,
  body,
  action,
  danger = false,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  title: string
  body: string
  action: string
  danger?: boolean
  busy: boolean
  error: string | null
  onConfirm: (code: string) => void
  onCancel: () => void
}) {
  const [code, setCode] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // The settings dialog underneath closes on Escape too; this one goes first.
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  return (
    <div
      className="modal-backdrop ops-confirm-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <form
        className="modal ops-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ops-confirm-title"
        data-testid="ops-confirm"
        onSubmit={(event) => {
          event.preventDefault()
          if (code.trim() && !busy) onConfirm(code)
        }}
      >
        <h2 id="ops-confirm-title">{title}</h2>
        <p className="settings-hint">{body}</p>
        <label className="ops-confirm-label" htmlFor="ops-confirm-code">
          Onaylamak için davet kodunu yaz
        </label>
        <input
          id="ops-confirm-code"
          ref={input}
          data-testid="ops-confirm-code"
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        {error && (
          <p className="ops-error" role="alert" data-testid="ops-confirm-error">
            {error}
          </p>
        )}
        <div className="ops-confirm-actions">
          <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
            Vazgeç
          </button>
          <button
            type="submit"
            className={danger ? 'danger' : 'primary'}
            data-testid="ops-confirm-submit"
            disabled={busy || code.trim() === ''}
          >
            {busy ? 'Bekle…' : action}
          </button>
        </div>
      </form>
    </div>
  )
}
