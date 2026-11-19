/**
 * v4: what MessageList needs for the message family (CONTRACT-V4 B), kept out
 * of MessageList.tsx: the stable callbacks every row shares (so a change to
 * one message re-renders only its row), the gestures that open a message's
 * actions (desktop right-click and "⋯", long-press at phone width, the menu
 * key or Shift+F10 on a focused row, arrow keys between rows), and the layer
 * that draws the menu, the emoji picker and the delete confirmation.
 */
import { useEffect, useMemo, useRef, useState, type HTMLAttributes, type PointerEvent as ReactPointerEvent } from 'react'
import type { FamilyActions, JumpRequest } from '../../useMessageFamily'
import type { UiMessage } from '../../store'
import type { Message, User } from '../../types'
import { ActionMenu, type MenuChoice } from './ActionMenu'
import { DeleteConfirm } from './DeleteConfirm'
import { EmojiPicker } from './EmojiPicker'
import type { ActionKind } from './MessageActions'
import type { AnchorRect } from './Popover'
import { swallowPressEndClick } from '../../lib/pressEnd'

/** Passed down by Session. */
export interface ListFamily {
  nameOf: (userId: number) => string
  /** v4: a current member as shown now (name, avatar), or undefined for somebody no longer here. */
  userOf?: (userId: number) => User | undefined
  editingId: number | null
  jump: JumpRequest | null
  onJumpDone: () => void
  /** v4: the picker, the menu/sheet or the delete confirmation opened or closed (the reload guard asks). */
  onOverlayChange?: (open: boolean) => void
  actions: FamilyActions
}

/** One object for every row; its identity never changes. */
export interface RowFamily {
  meId: number
  nameOf: (userId: number) => string
  /** The current name of a member, undefined for a former one (then a snapshot is shown). */
  currentName: (userId: number) => string | undefined
  onAction: (message: Message, kind: ActionKind, anchor: AnchorRect) => void
  onToggleReaction: (message: Message, key: string) => void
  onJump: (messageId: number) => void
  onSaveEdit: (message: Message, content: string) => void
  onCancelEdit: () => void
  /** Test hook: counts row renders when the page defines `__trioRowRenders`. */
  probe: (key: string) => void
}

type Overlay =
  | { kind: 'menu' | 'picker'; messageId: number; anchor: AnchorRect | null }
  | { kind: 'delete'; messageId: number }

const LONG_PRESS_MS = 450
const LONG_PRESS_SLOP_PX = 10
const FLASH_MS = 1800
/** Where a long-press does not open the sheet (it would fight typing or a native gesture). */
const NO_LONG_PRESS = 'textarea, input, video, .msg-editor'
/** Where a right-click keeps the browser's own menu (copy a link, save an image). */
const NATIVE_MENU = 'a, img, video, textarea, input, .msg-editor'

function rowOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>('li[data-message-id]') : null
}

function pointRect(x: number, y: number): AnchorRect {
  return { top: y, bottom: y, left: x, right: x }
}

export interface RowFamilyHandle {
  row: RowFamily | undefined
  gestures: HTMLAttributes<HTMLOListElement>
  overlay: Overlay | null
  setOverlay: (overlay: Overlay | null) => void
  /** Bring a row into view (centred) and flash it. */
  reveal: (scroller: HTMLElement, row: HTMLElement) => void
}

export function useRowFamily(family: ListFamily | undefined, meId: number): RowFamilyHandle {
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const latest = useRef(family)
  latest.current = family
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null)
  /** A long-press just opened the sheet: swallow the click (and the context menu) it ends with. */
  const pressed = useRef(false)
  const keyboardMenuAt = useRef(0)
  const enabled = family !== undefined

  const row = useMemo<RowFamily | undefined>(() => {
    if (!enabled) return undefined
    const actions = () => latest.current?.actions
    return {
      meId,
      nameOf: (id) => latest.current?.nameOf(id) ?? `#${id}`,
      currentName: (id) => latest.current?.userOf?.(id)?.name,
      onAction: (message, kind, anchor) => {
        if (kind === 'react') setOverlay({ kind: 'picker', messageId: message.id, anchor })
        else if (kind === 'menu') setOverlay({ kind: 'menu', messageId: message.id, anchor })
        else if (kind === 'reply') actions()?.startReply(message)
        else actions()?.startEdit(message)
      },
      onToggleReaction: (message, key) => actions()?.toggleReaction(message, key),
      onJump: (messageId) => actions()?.jumpTo(messageId),
      onSaveEdit: (message, content) => actions()?.saveEdit(message, content),
      onCancelEdit: () => actions()?.cancelEdit(),
      probe: (key) => {
        const counter = (globalThis as { __trioRowRenders?: Record<string, number> }).__trioRowRenders
        if (counter) counter[key] = (counter[key] ?? 0) + 1
      },
    }
  }, [enabled, meId])

  const gestures = useMemo<HTMLAttributes<HTMLOListElement>>(() => {
    if (!enabled) return {}
    const cancel = () => {
      if (press.current) clearTimeout(press.current.timer)
      press.current = null
    }
    const idOf = (element: HTMLElement) => Number(element.dataset.messageId)
    return {
      onPointerDown: (event: ReactPointerEvent<HTMLOListElement>) => {
        pressed.current = false
        if (event.pointerType !== 'touch') return
        const target = rowOf(event.target)
        if (!target || (event.target as Element).closest(NO_LONG_PRESS)) return
        cancel()
        press.current = {
          x: event.clientX,
          y: event.clientY,
          timer: setTimeout(() => {
            press.current = null
            pressed.current = true
            // The sheet may open under the finger: the click this press ends with must not land on it.
            swallowPressEndClick(document)
            navigator.vibrate?.(10)
            setOverlay({ kind: 'menu', messageId: idOf(target), anchor: null })
          }, LONG_PRESS_MS),
        }
      },
      onPointerMove: (event: ReactPointerEvent<HTMLOListElement>) => {
        const start = press.current
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP_PX) cancel()
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onClickCapture: (event) => {
        if (!pressed.current) return
        pressed.current = false
        event.preventDefault()
        event.stopPropagation()
      },
      onContextMenu: (event) => {
        const target = rowOf(event.target)
        if (!target) return
        if (press.current || pressed.current) {
          // The touch long-press: our sheet, not the browser's menu or text selection.
          event.preventDefault()
          return
        }
        if ((event.target as Element).closest(NATIVE_MENU)) return
        event.preventDefault()
        if (Date.now() - keyboardMenuAt.current < 500) return
        const keyboard = event.clientX === 0 && event.clientY === 0
        const box = target.getBoundingClientRect()
        setOverlay({
          kind: 'menu',
          messageId: idOf(target),
          anchor: keyboard ? { top: box.top, bottom: box.top + 24, left: box.left, right: box.right - 16 } : pointRect(event.clientX, event.clientY),
        })
      },
      onKeyDown: (event) => {
        const target = rowOf(event.target)
        if (!target || event.target !== target) return
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
          event.preventDefault()
          keyboardMenuAt.current = Date.now()
          const box = target.getBoundingClientRect()
          setOverlay({ kind: 'menu', messageId: idOf(target), anchor: { top: box.top, bottom: box.top + 24, left: box.left, right: box.right - 16 } })
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          const rows = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('li[data-message-id]')]
          const next = rows[rows.indexOf(target) + (event.key === 'ArrowUp' ? -1 : 1)]
          if (next) {
            event.preventDefault()
            next.focus()
          }
        }
      },
    }
  }, [enabled])

  const reveal = (scroller: HTMLElement, element: HTMLElement) => {
    const box = element.getBoundingClientRect()
    const view = scroller.getBoundingClientRect()
    scroller.scrollTop += box.top - view.top - Math.max(0, (scroller.clientHeight - box.height) / 2)
    element.classList.remove('msg-flash')
    // Restart the animation even when the same row flashes twice.
    void element.offsetWidth
    element.classList.add('msg-flash')
    setTimeout(() => element.classList.remove('msg-flash'), FLASH_MS)
    element.focus({ preventScroll: true })
  }

  useEffect(() => () => {
    if (press.current) clearTimeout(press.current.timer)
  }, [])

  const open = overlay !== null
  useEffect(() => {
    latest.current?.onOverlayChange?.(open)
    return () => latest.current?.onOverlayChange?.(false)
  }, [open])

  return { row, gestures, overlay, setOverlay, reveal }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Not a secure context (plain http on a LAN): the old way.
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    const done = document.execCommand('copy')
    area.remove()
    return done
  }
}

/** The menu, the picker and the confirmation for the message they were opened on. */
export function MessageFamilyLayer({
  family,
  items,
  myId,
  rowFamily,
}: {
  family: ListFamily
  items: readonly UiMessage[]
  myId: number
  rowFamily: RowFamilyHandle
}) {
  const { overlay, setOverlay } = rowFamily
  const { actions, nameOf, editingId } = family
  const message = overlay ? items.find((item) => item.status === 'sent' && item.id === overlay.messageId) : undefined

  // The message went away (deleted by its author) while its menu was open.
  useEffect(() => {
    if (overlay && !message) setOverlay(null)
  }, [overlay, message, setOverlay])

  // The row being edited is brought into view (the up-arrow can pick one far below or above).
  useEffect(() => {
    if (editingId === null) return
    document.querySelector(`li[data-message-id="${editingId}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [editingId])

  if (!overlay || !message) return null
  const close = () => setOverlay(null)
  const own = message.author.id === myId

  if (overlay.kind === 'delete') {
    return (
      <DeleteConfirm
        message={message}
        onCancel={close}
        onConfirm={() => {
          close()
          actions.remove(message)
        }}
      />
    )
  }

  if (overlay.kind === 'picker') {
    const mine = new Set((message.reactions ?? []).filter((reaction) => reaction.user_ids.includes(myId)).map((reaction) => reaction.key))
    return (
      <EmojiPicker
        anchor={overlay.anchor}
        mine={mine}
        onClose={close}
        onPick={(emoji) => {
          close()
          actions.toggleReaction(message, emoji)
        }}
      />
    )
  }

  const choose = (choice: MenuChoice) => {
    switch (choice) {
      case 'react':
        setOverlay({ kind: 'picker', messageId: message.id, anchor: overlay.anchor })
        return
      case 'delete':
        setOverlay({ kind: 'delete', messageId: message.id })
        return
      case 'reply':
        actions.startReply(message)
        break
      case 'edit':
        actions.startEdit(message)
        break
      case 'pin':
        actions.togglePin(message)
        break
      case 'copy':
        void copyText(message.content).then((done) => actions.showNotice(done ? 'Metin kopyalandı.' : 'Kopyalanamadı.'))
        break
    }
    close()
  }

  return (
    <ActionMenu
      message={message}
      own={own}
      meId={myId}
      anchor={overlay.anchor}
      nameOf={nameOf}
      onClose={close}
      onChoose={choose}
      onReact={(key) => {
        close()
        actions.toggleReaction(message, key)
      }}
    />
  )
}
