import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { swallowPressEndClick } from '../../lib/pressEnd'
import { notifyHub } from '../../lib/notify/notifyHub'
import type { Level } from '../../lib/notify/pushApi'

export const LEVEL_LABELS: Record<Level, string> = {
  all: 'Hepsi',
  mentions: 'Yalnız @ben',
  none: 'Kapalı',
}

/**
 * "Bildirimler: Hepsi / Yalnız @ben / Kapalı" on a channel's context menu
 * (right click, or a long press where the browser turns it into one). Listens
 * on the document for the sidebar's channel buttons, so the sidebar needs no
 * change.
 */
export function ChannelNotifyMenu() {
  const notify = useSyncExternalStore(notifyHub.subscribe, notifyHub.getSnapshot)
  const [menu, setMenu] = useState<{ channelId: number; name: string; x: number; y: number } | null>(null)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onContext = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const button = target?.closest<HTMLElement>('.sidebar button[data-testid^="channel-"]')
      const id = Number(button?.dataset.testid?.slice('channel-'.length))
      if (!button || !Number.isInteger(id) || notify.prefs === null) return
      event.preventDefault()
      swallowPressEndClick(document)
      const name = button.querySelector('.channel-name')?.textContent ?? ''
      setMenu({ channelId: id, name, x: event.clientX, y: event.clientY })
    }
    document.addEventListener('contextmenu', onContext)
    return () => document.removeEventListener('contextmenu', onContext)
  }, [notify.prefs])

  useEffect(() => {
    if (!menu) return
    box.current?.querySelector<HTMLElement>('[aria-checked="true"], button')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMenu(null)
      }
    }
    const onDown = (event: PointerEvent) => {
      if (box.current && event.target instanceof Node && !box.current.contains(event.target)) setMenu(null)
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [menu])

  if (!menu || !notify.prefs) return null
  const current = notify.prefs.channels[String(menu.channelId)] ?? 'all'
  const width = 220
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - width - 8))
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 170))
  return (
    <div
      ref={box}
      className="channel-notify-menu"
      role="menu"
      aria-label={`#${menu.name} bildirimleri`}
      data-testid="channel-notify-menu"
      style={{ left, top, width }}
    >
      <div className="channel-notify-title">Bildirimler · {menu.name}</div>
      {(Object.keys(LEVEL_LABELS) as Level[]).map((level) => (
        <button
          key={level}
          type="button"
          role="menuitemradio"
          aria-checked={current === level}
          data-testid={`channel-notify-${level}`}
          onClick={() => {
            void notifyHub.savePrefs({ channels: { [String(menu.channelId)]: level } })
            setMenu(null)
          }}
        >
          <span className="check" aria-hidden="true">{current === level ? '✓' : ''}</span>
          {LEVEL_LABELS[level]}
        </button>
      ))}
    </div>
  )
}
