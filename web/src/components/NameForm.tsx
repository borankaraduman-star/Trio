import { useEffect, useRef, useState, type FormEvent } from 'react'
import { profileErrorMessage } from '../lib/profileApi'

/** Trimmed length as the server counts it (code points), 1–32. */
export function nameLength(value: string): number {
  return [...value.trim()].length
}

/**
 * A name to change (one's own, the server's): the same rules and the same
 * Turkish messages as joining. `onEditing` is true while a typed name is not saved.
 */
export function NameForm({
  testId,
  label,
  value,
  save,
  onEditing,
}: {
  testId: string
  label: string
  value: string
  /** Resolves with the name as the server stored it. */
  save: (name: string) => Promise<string>
  onEditing?: (editing: boolean) => void
}) {
  const [draft, setDraft] = useState(value)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const shown = useRef(value)

  // Changed elsewhere (another device, another person): follow it unless something is being typed.
  useEffect(() => {
    if (draft === shown.current) setDraft(value)
    shown.current = value
    // Only a new `value` drives this; the draft is read as it is then.
  }, [value])

  const trimmed = draft.trim()
  const dirty = trimmed !== value
  useEffect(() => {
    onEditing?.(dirty)
  }, [dirty, onEditing])
  useEffect(() => () => onEditing?.(false), [onEditing])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!dirty || busy) return
    const length = nameLength(draft)
    if (length < 1 || length > 32) {
      setError('İsim 1–32 karakter olmalı.')
      return
    }
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const stored = await save(trimmed)
      shown.current = stored
      setDraft(stored)
      setSaved(true)
    } catch (failure) {
      setError(profileErrorMessage(failure, 'name'))
    } finally {
      setBusy(false)
    }
  }

  const inputId = `${testId}-input`
  return (
    <form className="settings-field name-form" data-testid={testId} onSubmit={(event) => void submit(event)}>
      <label htmlFor={inputId}>{label}</label>
      <div className="name-form-row">
        <input
          id={inputId}
          data-testid={inputId}
          value={draft}
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setDraft(event.target.value)
            setSaved(false)
            setError(null)
          }}
        />
        <button type="submit" className="primary" data-testid={`${testId}-save`} disabled={!dirty || trimmed === '' || busy}>
          {busy ? 'Kaydediliyor…' : 'Kaydet'}
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert" data-testid={`${testId}-error`}>
          {error}
        </p>
      )}
      {saved && !error && (
        <p className="settings-hint name-form-saved" role="status" data-testid={`${testId}-saved`}>
          Kaydedildi.
        </p>
      )}
    </form>
  )
}
