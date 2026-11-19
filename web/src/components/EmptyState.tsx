/**
 * A decorative illustration for an empty place (an empty channel, a voice room
 * you are alone in). The image has explicit dimensions so nothing moves while
 * it loads, and alt="" because the text beside it says what it means.
 */
const ART = {
  chat: { src: '/art/empty-chat.webp', width: 240, height: 180 },
  voice: { src: '/art/empty-voice.webp', width: 160, height: 120 },
} as const

export function EmptyState({ art, text }: { art: keyof typeof ART; text?: string }) {
  const image = ART[art]
  return (
    <div className={`empty-state empty-state-${art}`}>
      <img src={image.src} width={image.width} height={image.height} alt="" decoding="async" draggable={false} />
      {text && <p>{text}</p>}
    </div>
  )
}
