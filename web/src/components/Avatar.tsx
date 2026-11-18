const COLORS = ['#5865f2', '#3ba55d', '#eb459e', '#f0a020', '#ed4245', '#2aa7c9', '#9b59b6']

export function Avatar({
  id,
  name,
  size = 32,
  speaking = false,
}: {
  id: number
  name: string
  size?: number
  speaking?: boolean
}) {
  const initial = [...name.trim()][0]?.toLocaleUpperCase('tr-TR') ?? '?'
  return (
    <span
      className={speaking ? 'avatar speaking' : 'avatar'}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.45),
        background: COLORS[Math.abs(id) % COLORS.length],
      }}
      aria-hidden="true"
    >
      {initial}
    </span>
  )
}
