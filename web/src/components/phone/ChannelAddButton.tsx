import { useEffect, useRef, useState } from 'react'
import type { ChannelKind } from '../../types'
import { HashIcon, PlusIcon, SpeakerIcon } from '../icons'

/**
 * CONTRACT-V7-PHONE §4: ONE "+" for new channels, which asks which kind.
 * It only creates; managing an existing channel (rename, delete) belongs on
 * the channel's own row, not in this menu.
 */
export function ChannelAddButton({ adding, onChoose }: { adding: ChannelKind | null; onChoose: (kind: ChannelKind | null) => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const choose = (kind: ChannelKind) => {
    setOpen(false)
    onChoose(adding === kind ? null : kind)
  }

  return (
    <div className="v7-add-channel" ref={box}>
      <button
        type="button"
        className="icon-button small"
        data-testid="add-channel"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Kanal ekle"
        aria-label="Kanal ekle"
        onClick={() => setOpen((value) => !value)}
      >
        <PlusIcon size={18} />
      </button>
      {open && (
        <div className="v7-add-channel-menu" role="menu" aria-label="Hangi tür kanal?">
          <button type="button" role="menuitem" data-testid="add-channel-text" onClick={() => choose('text')}>
            <HashIcon size={16} />
            <span>
              Metin kanalı
              <small>Mesajlar, dosyalar</small>
            </span>
          </button>
          <button type="button" role="menuitem" data-testid="add-channel-voice" onClick={() => choose('voice')}>
            <SpeakerIcon size={16} />
            <span>
              Ses kanalı
              <small>Görüşme, ekran, kamera</small>
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
