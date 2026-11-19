import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { formatDuration, HOLD_MS, MAX_RECORDING_MS, micErrorMessage, MIN_RECORDING_MS, slidAway } from '../../lib/voiceNote'
import { VoiceRecorder, type Recording } from '../../lib/voiceRecorder'

type Phase = 'idle' | 'starting' | 'recording'

function MicIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8" />
    </svg>
  )
}

/**
 * The composer's microphone (CONTRACT-V6-MEDIA §4): press and hold to record,
 * let go to send, slide away or Esc to cancel; or click to start and click
 * "Gönder" to stop (keyboard and screen readers). At most two minutes.
 */
export function VoiceRecordButton({
  onRecorded,
  onError,
  onActiveChange,
}: {
  onRecorded: (recording: Recording) => void
  onError: (message: string) => void
  /** Recording (or asking for the microphone): the composer shows the recording bar. */
  onActiveChange?: (active: boolean) => void
}) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [held, setHeld] = useState(false)
  const recorder = useRef<VoiceRecorder | null>(null)
  const press = useRef<{ x: number; y: number; at: number; pointerId: number } | null>(null)
  const callbacks = useRef({ onRecorded, onError, onActiveChange })
  callbacks.current = { onRecorded, onError, onActiveChange }

  /**
   * The phase, and the composer told in the SAME update: reported from an
   * effect, the composer switched its layout one render after the bar, and
   * for that frame the microphone stood where the paperclip is (a press
   * meant for the microphone opened the file picker).
   */
  const go = useCallback((next: Phase) => {
    setPhase(next)
    callbacks.current.onActiveChange?.(next !== 'idle')
  }, [])

  const finish = useCallback(async (send: boolean) => {
    const current = recorder.current
    recorder.current = null
    press.current = null
    setHeld(false)
    go('idle')
    setElapsed(0)
    setLevel(0)
    if (!current) return
    if (!send || current.elapsedMs < MIN_RECORDING_MS) {
      current.cancel()
      return
    }
    const recording = await current.stop()
    if (recording && recording.file.size > 0) callbacks.current.onRecorded(recording)
  }, [go])

  const begin = useCallback(async () => {
    if (recorder.current) return
    const next = new VoiceRecorder(
      (ms, peak) => {
        setElapsed(ms)
        setLevel(peak)
      },
      () => void finish(true),
    )
    recorder.current = next
    go('starting')
    try {
      await next.start()
    } catch (error) {
      recorder.current = null
      press.current = null
      setHeld(false)
      go('idle')
      callbacks.current.onError(micErrorMessage(error))
      return
    }
    if (recorder.current !== next) return // cancelled while the permission was asked
    go('recording')
  }, [finish, go])

  // Esc cancels, wherever the focus is.
  useEffect(() => {
    if (phase === 'idle') return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      void finish(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [phase, finish])

  // Unmounted while recording (channel switch, sign-out): nothing is sent.
  useEffect(() => () => recorder.current?.cancel(), [])

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    if (phase === 'recording' && !held) {
      // Click-to-record: a second press on the microphone stops and sends.
      event.preventDefault()
      void finish(true)
      return
    }
    if (phase !== 'idle') return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    // The press is timed by when the events HAPPENED (`timeStamp`), not by when
    // this page got round to handling them: on a busy phone the render this
    // press starts can hold the pointerup back past HOLD_MS, and a quick tap
    // was then taken for a short hold, stopped at once and dropped as too short.
    press.current = { x: event.clientX, y: event.clientY, at: event.timeStamp, pointerId: event.pointerId }
    setHeld(true)
    void begin()
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = press.current
    if (!start || start.pointerId !== event.pointerId) return
    if (slidAway(event.clientX - start.x, event.clientY - start.y)) void finish(false)
  }
  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = press.current
    if (!start || start.pointerId !== event.pointerId) return
    press.current = null
    setHeld(false)
    // A short press: click-to-record (it keeps running until "Gönder").
    if (event.timeStamp - start.at >= HOLD_MS) void finish(true)
  }
  const onPointerCancel = () => {
    if (press.current) void finish(false)
  }

  const percent = Math.min(100, Math.round(Math.sqrt(level) * 100))
  return (
    <>
      {phase !== 'idle' && (
        <div className="voice-recording" data-testid="voice-recording" data-phase={phase} role="group" aria-label="Sesli mesaj kaydı">
          <span className="voice-recording-dot" aria-hidden="true" />
          <span className="voice-recording-time" data-testid="voice-recording-time" aria-live="off">
            {phase === 'starting' ? 'Mikrofon açılıyor…' : `${formatDuration(elapsed)} / ${formatDuration(MAX_RECORDING_MS)}`}
          </span>
          <span className="voice-recording-meter" data-testid="voice-level" data-level={level.toFixed(3)} aria-hidden="true">
            <span style={{ width: `${percent}%` }} />
          </span>
          <span className="voice-recording-hint">{held ? 'Bırakınca gönderilir · iptal için kaydır ya da Esc' : 'Esc ile iptal'}</span>
          <button
            type="button"
            className="icon-button"
            data-testid="voice-cancel"
            aria-label="Kaydı iptal et"
            title="Kaydı iptal et (Esc)"
            onClick={() => void finish(false)}
          >
            ✕
          </button>
          <button
            type="button"
            className="primary voice-send"
            data-testid="voice-send"
            disabled={phase !== 'recording'}
            onClick={() => void finish(true)}
          >
            Gönder
          </button>
        </div>
      )}
      <button
        type="button"
        className={`icon-button voice-record-button${phase !== 'idle' ? ' active' : ''}`}
        data-testid="btn-voice"
        title="Sesli mesaj: basılı tut ve konuş, bırakınca gönderilir (ya da tıkla, konuş, Gönder'e bas)"
        aria-label={phase === 'idle' ? 'Sesli mesaj kaydet' : 'Kaydı bitir ve gönder'}
        aria-pressed={phase !== 'idle'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClick={(event) => {
          // Keyboard (Enter/Space) gives a click with no pointer: start, or stop and send.
          if (event.detail !== 0) return
          if (phase === 'idle') void begin()
          else if (phase === 'recording') void finish(true)
        }}
      >
        <MicIcon />
      </button>
    </>
  )
}
