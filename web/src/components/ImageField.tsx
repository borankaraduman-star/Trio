import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react'
import { decodeImage, ImageDecodeError, looksLikeHeic, MAX_IMAGE_BYTES, type DecodedImage } from '../lib/imageEncode'
import { profileErrorMessage } from '../lib/profileApi'
import { ImageCropper } from './ImageCropper'

/** Turkish for a picked file the browser could not make a picture of. */
export function decodeErrorMessage(error: unknown, file: { type: string; name: string }): string {
  if (looksLikeHeic(file)) {
    return 'HEIC biçimindeki fotoğraflar bu tarayıcıda açılamıyor. Fotoğrafı JPEG ya da PNG olarak kaydedip tekrar dene (iPhone’da: Ayarlar › Kamera › Biçimler › En Uyumlu).'
  }
  if (error instanceof ImageDecodeError) {
    if (error.reason === 'not-image') return 'Bu dosya bir görsel değil. JPEG, PNG ya da WebP seç.'
    if (error.reason === 'too-large') return 'Dosya çok büyük; 40 MB’tan küçük bir görsel seç.'
  }
  return 'Bu görsel bu tarayıcıda açılamıyor; JPEG, PNG ya da WebP dene.'
}

/** The first file of a drop or a paste that could be a picture. */
function firstFile(list: FileList | null | undefined): File | null {
  if (!list) return null
  return [...list].find((file) => file.type === '' || file.type.startsWith('image/')) ?? list[0] ?? null
}

/**
 * A picture setting (an avatar, the server's icon): the current one, "choose"
 * (also by dropping or pasting a picture onto the field), the cropper, upload,
 * remove. `onEditing` says while the cropper is open (the reload guard).
 */
export function ImageField({
  testId,
  label,
  preview,
  hasImage,
  shape,
  cropTitle,
  upload,
  remove,
  onEditing,
}: {
  testId: string
  label: string
  preview: ReactNode
  hasImage: boolean
  shape: 'circle' | 'rounded'
  cropTitle: string
  upload: (blob: Blob, ext: string) => Promise<void>
  remove: () => Promise<void>
  onEditing?: (editing: boolean) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [image, setImage] = useState<DecodedImage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cropError, setCropError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    onEditing?.(image !== null)
  }, [image, onEditing])
  useEffect(() => () => onEditing?.(false), [onEditing])
  // A decoded bitmap holds memory until it is closed.
  useEffect(() => () => image?.close(), [image])

  const open = async (file: File | null) => {
    if (!file) return
    setError(null)
    setCropError(null)
    // HEIC is tried too (Safari decodes it); it is explained only when it fails.
    try {
      setImage(await decodeImage(file))
    } catch (failure) {
      setError(decodeErrorMessage(failure, file))
    }
  }

  const save = async (encoded: { blob: Blob; ext: string } | null) => {
    if (!encoded || encoded.blob.size === 0) {
      setCropError('Bu tarayıcı görseli kodlayamadı.')
      return
    }
    if (encoded.blob.size > MAX_IMAGE_BYTES) {
      setCropError('Görüntü çok büyük (en fazla 2 MB).')
      return
    }
    setBusy(true)
    setCropError(null)
    try {
      await upload(encoded.blob, encoded.ext)
      setImage(null)
    } catch (failure) {
      setCropError(profileErrorMessage(failure, 'image'))
    } finally {
      setBusy(false)
    }
  }

  const removeImage = async () => {
    setBusy(true)
    setError(null)
    try {
      await remove()
    } catch (failure) {
      setError(profileErrorMessage(failure, 'image'))
    } finally {
      setBusy(false)
    }
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    void open(firstFile(event.dataTransfer?.files))
  }

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const file = firstFile(event.clipboardData?.files)
    if (!file) return
    event.preventDefault()
    void open(file)
  }

  return (
    <div className="settings-field image-field" data-testid={testId}>
      <span className="settings-label">{label}</span>
      <div
        className={dragging ? 'image-field-zone dragging' : 'image-field-zone'}
        tabIndex={0}
        aria-label={`${label}: bir görsel bırak ya da yapıştır`}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onPaste={onPaste}
      >
        {preview}
        <div className="image-field-actions">
          <button
            type="button"
            className="primary"
            data-testid={`${testId}-choose`}
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            {hasImage ? 'Değiştir' : 'Görsel seç'}
          </button>
          {hasImage && (
            <button
              type="button"
              className="ghost danger-text"
              data-testid={`${testId}-remove`}
              disabled={busy}
              onClick={() => void removeImage()}
            >
              Kaldır
            </button>
          )}
          <span className="image-field-tip">ya da buraya sürükle / yapıştır</span>
        </div>
        <input
          ref={input}
          type="file"
          accept="image/*"
          hidden
          data-testid={`${testId}-input`}
          onChange={(event) => {
            const file = event.target.files?.[0] ?? null
            event.target.value = ''
            void open(file)
          }}
        />
      </div>
      {error && (
        <p className="form-error" role="alert" data-testid={`${testId}-error`}>
          {error}
        </p>
      )}
      {image && (
        <ImageCropper
          image={image}
          shape={shape}
          title={cropTitle}
          busy={busy}
          error={cropError}
          onCancel={() => setImage(null)}
          onConfirm={(encoded) => void save(encoded)}
        />
      )}
    </div>
  )
}
