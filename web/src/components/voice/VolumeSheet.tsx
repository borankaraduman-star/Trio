import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type HTMLAttributes, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { swallowPressEndClick } from '../../lib/pressEnd'
import { MAX_VOLUME, voicePrefsStore, volumeOf, type PersonVolume } from '../../lib/voicePrefs'
import type { Member } from '../../types'
import { Avatar } from '../Avatar'
import { CloseIcon } from '../icons2'
import { VolumeIcon } from './icons'

const LONG_PRESS_MS = 450
const LONG_PRESS_SLOP_PX = 10

export interface VolumeTarget {
  userId: number
  /** Where it was opened (a right-click); null = a sheet from the bottom (long-press, keyboard). */
  at: { x: number; y: number } | null
}

/**
 * Right-click, long-press (CLAUDE.md: the click that ends it is swallowed) or
 * the menu key on somebody's row in the voice room opens their volume sheet.
 */
export function useParticipantMenu(open: (target: VolumeTarget) => void) {
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null)
  const latest = useRef(open)
  latest.current = open
  return useMemo(() => {
    const cancel = () => {
      if (press.current) clearTimeout(press.current.timer)
      press.current = null
    }
    return (userId: number): HTMLAttributes<HTMLElement> => ({
      tabIndex: 0,
      'aria-haspopup': 'dialog',
      onContextMenu: (event) => {
        event.preventDefault()
        if (press.current) return
        const keyboard = event.clientX === 0 && event.clientY === 0
        latest.current({ userId, at: keyboard ? null : { x: event.clientX, y: event.clientY } })
      },
      onKeyDown: (event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
          event.preventDefault()
          latest.current({ userId, at: null })
        }
      },
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        if (event.pointerType !== 'touch') return
        cancel()
        press.current = {
          x: event.clientX,
          y: event.clientY,
          timer: setTimeout(() => {
            press.current = null
            swallowPressEndClick(document)
            navigator.vibrate?.(10)
            latest.current({ userId, at: null })
          }, LONG_PRESS_MS),
        }
      },
      onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
        const start = press.current
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP_PX) cancel()
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
    })
  }, [])
}

function percent(value: number): string {
  return `%${Math.round(value * 100)}`
}

function Slider({
  label,
  kind,
  userId,
  value,
}: {
  label: string
  kind: keyof PersonVolume
  userId: number
  value: number
}) {
  const id = `volume-${kind}-${userId}`
  return (
    <div className="volume-field">
      <label htmlFor={id}>
        {label}
        <output data-testid={`volume-${kind}-value`}>{percent(value)}</output>
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={MAX_VOLUME * 100}
        step={5}
        value={Math.round(value * 100)}
        data-testid={`volume-${kind}`}
        className={value > 1 ? 'boost' : undefined}
        style={{ ['--fill' as string]: `${(value / MAX_VOLUME) * 100}%` }}
        onChange={(event) => voicePrefsStore.setVolume(userId, kind, Number(event.target.value) / 100)}
      />
    </div>
  )
}

/** The per-person volume sheet (CONTRACT-V6-VOICE §3): local only, remembered per user. */
export function VolumeSheet({
  target,
  user,
  hasStreamAudio,
  onClose,
  extra,
}: {
  target: VolumeTarget
  user: Member | undefined
  hasStreamAudio: boolean
  onClose: () => void
  /** V8: the music volume and mute, while they share music. */
  extra?: ReactNode
}) {
  const prefs = useSyncExternalStore(voicePrefsStore.subscribe, voicePrefsStore.getSnapshot)
  const volume = volumeOf(prefs, target.userId)
  const box = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const name = user?.name ?? `#${target.userId}`

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    box.current?.querySelector<HTMLElement>('input')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
  }, [onClose])

  useEffect(() => {
    // Beside the pointer, kept on screen; a sheet on a narrow screen (CSS).
    const element = box.current
    if (!target.at || !element) return setPosition(null)
    const width = element.offsetWidth
    const height = element.offsetHeight
    const left = Math.max(8, Math.min(target.at.x, window.innerWidth - width - 8))
    const top = Math.max(8, Math.min(target.at.y, window.innerHeight - height - 8))
    setPosition({ left, top })
  }, [target])

  const anchored = target.at !== null && position !== null
  return (
    <div
      className={`volume-backdrop${target.at ? ' anchored' : ''}`}
      // A click, not a mousedown: the touch that opened the sheet ends with a
      // compatibility mousedown under the finger, and only its click is swallowed (pressEnd).
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={box}
        className={`volume-sheet${anchored ? ' at' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={`${name}: ses düzeyi`}
        data-testid="volume-sheet"
        style={anchored ? { left: position.left, top: position.top } : undefined}
      >
        <header>
          <Avatar id={target.userId} name={name} size={32} url={user?.avatar_url} />
          <strong>{name}</strong>
          <button type="button" className="icon-button small" aria-label="Kapat" onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </header>
        <Slider label="Ses" kind="voice" userId={target.userId} value={volume.voice} />
        {hasStreamAudio && <Slider label="Yayın sesi" kind="stream" userId={target.userId} value={volume.stream} />}
        {extra}
        {(volume.voice > 1 || volume.stream > 1) && (
          <p className="volume-hint">
            <VolumeIcon size={14} /> %100'ün üstü yalnız senin için yükseltilir; hoparlörde yankı yapabilir, kulaklık önerilir.
          </p>
        )}
        <p className="volume-hint quiet">Yalnız sende geçerli; o kişi bunu görmez.</p>
        <footer>
          <button type="button" className="ghost" data-testid="volume-reset" onClick={() => voicePrefsStore.resetVolume(target.userId)}>
            Sıfırla
          </button>
          <button type="button" className="ghost" data-testid="volume-reset-all" onClick={() => voicePrefsStore.resetAllVolumes()}>
            Herkes için sıfırla
          </button>
        </footer>
      </div>
    </div>
  )
}
