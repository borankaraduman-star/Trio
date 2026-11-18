import { useEffect, useRef } from 'react'
import { useSinkId } from '../useSinkId'
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
  useSinkId(ref)

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
