import { formatSize } from '../../lib/attachments'
import type { PendingAttachment } from '../../lib/pending'

/** A done chip's size; for a smaller copy, "before → after" and what was removed with it. */
export function PendingSize({ item }: { item: PendingAttachment }) {
  if (!item.downsized || item.originalSize === undefined) return <>{formatSize(item.size)}</>
  return (
    <span
      className="pending-shrunk"
      data-testid="pending-shrunk"
      title="Fotoğraf küçültülerek gönderilir. Yeniden kodlanan dosyada konum ve kamera bilgisi (EXIF) yok."
    >
      {formatSize(item.originalSize)} → {formatSize(item.size)}
      <br />
      konum bilgisi silindi
    </span>
  )
}

/** "Orijinali gönder": the picture as picked, at full size and with its EXIF. Remembered on this device. */
export function OriginalToggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="send-original" title="Açıkken fotoğraflar küçültülmeden, olduğu gibi (EXIF dahil) gönderilir.">
      <input
        type="checkbox"
        data-testid="send-original"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      Orijinali gönder
    </label>
  )
}
