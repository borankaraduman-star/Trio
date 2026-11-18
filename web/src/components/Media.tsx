import { useEffect, useRef } from 'react'
import type { RemoteMedia } from '../voice'

function attach(element: HTMLMediaElement, stream: MediaStream): () => void {
  element.srcObject = stream
  // The user clicked to join, so playback is allowed; a rejection (a browser
  // being stricter) must still not surface as an unhandled error.
  void element.play().catch(() => undefined)
  return () => {
    element.pause()
    element.srcObject = null
  }
}

/** One remote microphone. Deafen mutes the element, not the track. */
export function RemoteAudio({ media, muted }: { media: RemoteMedia; muted: boolean }) {
  const ref = useRef<HTMLAudioElement>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    return attach(element, media.stream)
  }, [media.stream])

  useEffect(() => {
    if (ref.current) ref.current.muted = muted
  }, [muted])

  return <audio ref={ref} autoPlay data-testid={`remote-audio-${media.userId}`} />
}

function ScreenTile({
  stream,
  label,
  muted,
  testId,
}: {
  stream: MediaStream
  label: string
  muted: boolean
  testId: string
}) {
  const ref = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    return attach(element, stream)
  }, [stream])

  useEffect(() => {
    if (ref.current) ref.current.muted = muted
  }, [muted])

  const toggleFullscreen = () => {
    const element = ref.current
    if (!element) return
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
    } else if (element.requestFullscreen) {
      void element.requestFullscreen().catch(() => undefined)
    }
  }

  return (
    <figure className="stage-tile">
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={muted}
        data-testid={testId}
        onClick={toggleFullscreen}
        title="Tam ekran için tıkla"
      />
      <figcaption>{label}</figcaption>
    </figure>
  )
}

/** Shared screens, above the chat. Renders nothing when nobody shares. */
export function Stage({
  remote,
  local,
  deafened,
  nameOf,
}: {
  remote: readonly RemoteMedia[]
  local: MediaStream | null
  deafened: boolean
  nameOf: (userId: number) => string
}) {
  if (remote.length === 0 && !local) return null
  return (
    <section className="stage" aria-label="Paylaşılan ekranlar">
      {remote.map((media) => (
        <ScreenTile
          key={media.stream.id}
          stream={media.stream}
          label={`${nameOf(media.userId)} ekranını paylaşıyor`}
          muted={deafened}
          testId="remote-video"
        />
      ))}
      {local && (
        // Own screen: always muted, or its audio would echo back.
        <ScreenTile stream={local} label="Senin ekranın" muted testId="local-video" />
      )}
    </section>
  )
}
