import { PinIcon } from './icons'

function fullTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** "(düzenlendi)", the edit time as its tooltip. */
export function EditedMark({ at }: { at: string | null }) {
  const title = at ? `Düzenlendi: ${fullTime(at)}` : 'Düzenleniyor…'
  return (
    <span className="msg-edited" data-testid="edited-mark" title={title}>
      (düzenlendi)
    </span>
  )
}

export function PinMark({ by }: { by: string | null }) {
  const title = by ? `Sabitlendi (${by})` : 'Sabitlendi'
  return (
    <span className="msg-pin-mark" data-testid="pin-mark" title={title} aria-label={title} role="img">
      <PinIcon size={14} />
    </span>
  )
}
