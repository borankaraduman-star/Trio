/**
 * The Trio mark: three coral dots in a triangle (design/concepts/logo-a.png),
 * drawn inline so it costs nothing to load and stays sharp at any size.
 * Decorative: the word "Trio" beside it is the accessible name.
 */
export function BrandMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className ? `brand-mark ${className}` : 'brand-mark'}
      width={size}
      height={Math.round(size * 0.93)}
      viewBox="0 0 100 93"
      aria-hidden="true"
      focusable="false"
    >
      <g fill="var(--brand-coral, #EE997F)">
        <circle cx="50" cy="24.05" r="23.1" />
        <circle cx="24.05" cy="69.05" r="23.1" />
        <circle cx="75.95" cy="69.05" r="23.1" />
      </g>
    </svg>
  )
}
