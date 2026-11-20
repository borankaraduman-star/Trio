import { useEffect, useRef } from 'react'

/**
 * Scroll reveal: every `[data-reveal]` inside the root gets `is-in` the first
 * time it comes near the screen. Only CSS moves it, and only when the root
 * says motion is on; with reduced motion (or no IntersectionObserver) nothing
 * is ever hidden.
 */
export function useReveal<E extends HTMLElement>(reduced: boolean) {
  const ref = useRef<E>(null)
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const items = [...root.querySelectorAll<HTMLElement>('[data-reveal]')]
    if (reduced || typeof IntersectionObserver === 'undefined') {
      items.forEach((item) => item.classList.add('is-in'))
      return
    }
    root.classList.add('can-reveal')
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          entry.target.classList.add('is-in')
          observer.unobserve(entry.target)
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    )
    items.forEach((item) => observer.observe(item))
    return () => observer.disconnect()
  }, [reduced])
  return ref
}

/** The three dots, small, as a marker. Decorative. */
export function Dots() {
  return (
    <span className="dots" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  )
}
