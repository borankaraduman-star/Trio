import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode, type RefObject } from 'react'
import { swallowPressEndClick } from '../../lib/pressEnd'
import { notifyHub } from '../../lib/notify/notifyHub'
import type { Level } from '../../lib/notify/pushApi'
import { LEVEL_LABELS } from '../notify/ChannelNotifyMenu'
import type { Channel, VoiceParticipant } from '../../types'
import { CloseIcon } from '../icons2'

const LONG_PRESS_MS = 450
const LONG_PRESS_SLOP_PX = 10
/** Android turns the same long press into a `contextmenu` as well: one menu, not two. */
const PRESS_CONTEXT_WINDOW_MS = 1000
const ROW = '.sidebar button[data-testid^="channel-"]'

export interface ChannelMenuProps {
  channels: Channel[]
  voiceMembers: Record<number, VoiceParticipant[]>
  /** CONTRACT-V6-OPS §1: only the owner deletes (the server says so too). */
  isOwner: boolean
  /** Null when it worked, else what to say. */
  onRename: (channelId: number, name: string) => Promise<string | null>
  onDelete: (channelId: number, confirmName: string) => Promise<string | null>
}

type Dialog = { kind: 'rename' | 'delete'; channel: Channel } | null

/** The channel row a pointer event or a context menu is on, else null. */
function rowChannelId(target: EventTarget | null): number | null {
  const element = target instanceof Element ? target.closest<HTMLElement>(ROW) : null
  const id = Number(element?.dataset.testid?.slice('channel-'.length))
  return element && Number.isInteger(id) ? id : null
}

/**
 * CONTRACT-V7-READING §6 (and V6-PUSH §6): a channel row's menu — right click,
 * the menu key, or a long press on touch (the click that ends the press is
 * swallowed, CLAUDE.md). Listens on the document for the sidebar's channel
 * buttons, so the sidebar needs no change. Notification levels (when push is
 * there), "Yeniden adlandır", and for the owner "Kanalı sil".
 */
export function ChannelMenu(props: ChannelMenuProps) {
  const notify = useSyncExternalStore(notifyHub.subscribe, notifyHub.getSnapshot)
  const [menu, setMenu] = useState<{ channelId: number; x: number; y: number } | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const box = useRef<HTMLDivElement>(null)
  const pressOpened = useRef(0)

  useEffect(() => {
    let press: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null
    const cancel = () => {
      if (press) clearTimeout(press.timer)
      press = null
    }
    const onContext = (event: MouseEvent) => {
      const id = rowChannelId(event.target)
      if (id === null) return
      event.preventDefault()
      if (Date.now() - pressOpened.current < PRESS_CONTEXT_WINDOW_MS) return
      swallowPressEndClick(document)
      setMenu({ channelId: id, x: event.clientX, y: event.clientY })
    }
    const onDown = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return
      const id = rowChannelId(event.target)
      if (id === null) return
      cancel()
      const { clientX: x, clientY: y } = event
      press = {
        x,
        y,
        timer: setTimeout(() => {
          press = null
          pressOpened.current = Date.now()
          swallowPressEndClick(document)
          navigator.vibrate?.(10)
          setMenu({ channelId: id, x, y })
        }, LONG_PRESS_MS),
      }
    }
    const onMove = (event: PointerEvent) => {
      if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > LONG_PRESS_SLOP_PX) cancel()
    }
    document.addEventListener('contextmenu', onContext)
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('pointermove', onMove, true)
    document.addEventListener('pointerup', cancel, true)
    document.addEventListener('pointercancel', cancel, true)
    return () => {
      cancel()
      document.removeEventListener('contextmenu', onContext)
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('pointermove', onMove, true)
      document.removeEventListener('pointerup', cancel, true)
      document.removeEventListener('pointercancel', cancel, true)
    }
  }, [])

  useEffect(() => {
    if (!menu) return
    box.current?.querySelector<HTMLElement>('[aria-checked="true"], button:not(:disabled)')?.focus()
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

  const channel = menu ? props.channels.find((c) => c.id === menu.channelId) : undefined
  const dialogChannel = dialog ? props.channels.find((c) => c.id === dialog.channel.id) : undefined

  return (
    <>
      {menu && channel && (
        <MenuBox
          box={box}
          menu={menu}
          channel={channel}
          props={props}
          level={notify.prefs ? (notify.prefs.channels[String(channel.id)] ?? 'all') : null}
          onLevel={(level) => {
            void notifyHub.savePrefs({ channels: { [String(channel.id)]: level } })
            setMenu(null)
          }}
          onOpen={(kind) => {
            setMenu(null)
            setDialog({ kind, channel })
          }}
        />
      )}
      {dialog?.kind === 'rename' && dialogChannel && (
        <RenameDialog channel={dialogChannel} onRename={props.onRename} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'delete' && dialogChannel && (
        <DeleteDialog channel={dialogChannel} onDelete={props.onDelete} onClose={() => setDialog(null)} />
      )}
    </>
  )
}

function deleteBlocker(channel: Channel, props: ChannelMenuProps): string | null {
  if (channel.kind === 'voice' && (props.voiceMembers[channel.id]?.length ?? 0) > 0) {
    return 'Ses kanalında biri varken silinemez'
  }
  if (channel.kind === 'text' && !props.channels.some((c) => c.kind === 'text' && c.id !== channel.id)) {
    return 'Son metin kanalı silinemez'
  }
  return null
}

function MenuBox({
  box,
  menu,
  channel,
  props,
  level,
  onLevel,
  onOpen,
}: {
  box: RefObject<HTMLDivElement>
  menu: { x: number; y: number }
  channel: Channel
  props: ChannelMenuProps
  level: Level | null
  onLevel: (level: Level) => void
  onOpen: (kind: 'rename' | 'delete') => void
}) {
  const width = 230
  const levels = (Object.keys(LEVEL_LABELS) as Level[]).filter((l) => channel.kind === 'text' || l !== 'mentions')
  const height = 60 + (level !== null ? levels.length * 36 + 30 : 0) + (props.isOwner ? 36 : 0)
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - width - 8))
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - height - 8))
  const blocker = deleteBlocker(channel, props)
  return (
    <div
      ref={box}
      className="channel-notify-menu channel-menu"
      role="menu"
      aria-label={`#${channel.name}`}
      data-testid="channel-notify-menu"
      style={{ left, top, width }}
    >
      {level !== null && (
        <>
          <div className="channel-notify-title">Bildirimler · {channel.name}</div>
          {levels.map((item) => (
            <button
              key={item}
              type="button"
              role="menuitemradio"
              aria-checked={level === item}
              data-testid={`channel-notify-${item}`}
              onClick={() => onLevel(item)}
            >
              <span className="check" aria-hidden="true">
                {level === item ? '✓' : ''}
              </span>
              {LEVEL_LABELS[item]}
            </button>
          ))}
          <div className="channel-menu-separator" role="separator" />
        </>
      )}
      {level === null && <div className="channel-notify-title">{channel.kind === 'text' ? '#' : '🔊 '}{channel.name}</div>}
      <button type="button" role="menuitem" data-testid="channel-rename" onClick={() => onOpen('rename')}>
        <span className="check" aria-hidden="true" />
        Yeniden adlandır
      </button>
      {props.isOwner && (
        <button
          type="button"
          role="menuitem"
          className="channel-menu-danger"
          data-testid="channel-delete"
          disabled={blocker !== null}
          title={blocker ?? undefined}
          onClick={() => onOpen('delete')}
        >
          <span className="check" aria-hidden="true" />
          {blocker ?? 'Kanalı sil'}
        </button>
      )}
    </div>
  )
}

function useDialogKeys(onClose: () => void, busy: boolean) {
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
  }, [onClose, busy])
}

function DialogFrame({
  title,
  testId,
  busy,
  onClose,
  children,
}: {
  title: string
  testId: string
  busy: boolean
  onClose: () => void
  children: ReactNode
}) {
  useDialogKeys(onClose, busy)
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div className="modal channel-dialog" role="dialog" aria-modal="true" aria-labelledby={`${testId}-title`} data-testid={testId}>
        <header className="modal-header">
          <h2 id={`${testId}-title`}>{title}</h2>
          <button type="button" className="icon-button" aria-label="Vazgeç" title="Vazgeç (Esc)" onClick={onClose} disabled={busy}>
            <CloseIcon />
          </button>
        </header>
        {children}
      </div>
    </div>
  )
}

function RenameDialog({
  channel,
  onRename,
  onClose,
}: {
  channel: Channel
  onRename: ChannelMenuProps['onRename']
  onClose: () => void
}) {
  const [name, setName] = useState(channel.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = name.trim()
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || trimmed === '') return
    if (trimmed === channel.name) return onClose()
    setBusy(true)
    const failure = await onRename(channel.id, trimmed)
    if (failure) {
      setError(failure)
      setBusy(false)
    } else onClose()
  }
  return (
    <DialogFrame title="Kanalı yeniden adlandır" testId="channel-rename-dialog" busy={busy} onClose={onClose}>
      <form className="channel-dialog-body" onSubmit={submit}>
        <label className="settings-label" htmlFor="channel-rename-input">
          Yeni ad
        </label>
        <input
          id="channel-rename-input"
          data-testid="channel-rename-input"
          value={name}
          maxLength={32}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            setName(event.target.value)
            setError(null)
          }}
        />
        <p className="settings-hint">Herkes için değişir; mesajlar ve bildirim ayarları kanalda kalır.</p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <footer className="channel-dialog-actions">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
          <button type="submit" className="primary" data-testid="channel-rename-save" disabled={busy || trimmed === ''}>
            {busy ? 'Kaydediliyor…' : 'Kaydet'}
          </button>
        </footer>
      </form>
    </DialogFrame>
  )
}

function DeleteDialog({
  channel,
  onDelete,
  onClose,
}: {
  channel: Channel
  onDelete: ChannelMenuProps['onDelete']
  onClose: () => void
}) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const text = channel.kind === 'text'
  // A text channel takes its messages with it: its name must be typed.
  const confirmed = !text || typed.trim() === channel.name
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || !confirmed) return
    setBusy(true)
    const failure = await onDelete(channel.id, channel.name)
    if (failure) {
      setError(failure)
      setBusy(false)
    } else onClose()
  }
  return (
    <DialogFrame
      title={text ? `#${channel.name} silinsin mi?` : `${channel.name} ses kanalı silinsin mi?`}
      testId="channel-delete-dialog"
      busy={busy}
      onClose={onClose}
    >
      <form className="channel-dialog-body" onSubmit={submit}>
        {text ? (
          <>
            <p>
              Kanaldaki <strong>bütün mesajlar, dosyalar, tepkiler ve sabitlenenler herkes için</strong> kalıcı olarak
              silinir. Bu geri alınamaz.
            </p>
            <label className="settings-label" htmlFor="channel-delete-input">
              Onaylamak için kanalın adını yaz: <strong>{channel.name}</strong>
            </label>
            <input
              id="channel-delete-input"
              data-testid="channel-delete-input"
              value={typed}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setTyped(event.target.value)
                setError(null)
              }}
            />
          </>
        ) : (
          <p>Ses kanalı herkes için kaldırılır. Kimse kanalda değil.</p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <footer className="channel-dialog-actions">
          <button type="button" className="ghost" onClick={onClose} disabled={busy} autoFocus={!text}>
            Vazgeç
          </button>
          <button type="submit" className="danger" data-testid="channel-delete-confirm" disabled={busy || !confirmed}>
            {busy ? 'Siliniyor…' : 'Kanalı sil'}
          </button>
        </footer>
      </form>
    </DialogFrame>
  )
}
