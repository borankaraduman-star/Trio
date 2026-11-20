import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { StepPlayer } from './player'

/** Whether the visitor asked for less motion; follows the setting live. */
export function useReducedMotion(): boolean {
  const query = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
  const [reduced, setReduced] = useState(() => query?.matches ?? false)
  useEffect(() => {
    if (!query) return
    const update = () => setReduced(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [query])
  return reduced
}

export interface Demo<E extends HTMLElement> {
  ref: RefObject<E>
  step: number
  last: number
  /** Running now: on screen, tab visible, motion allowed, not held. */
  playing: boolean
  reduced: boolean
  goTo(index: number): void
  next(): void
  previous(): void
  /** Held by the visitor's pause button. */
  paused: boolean
  /** Hold the demo for a reason (the pause button, typing, dragging); it plays again when no reason is left. */
  hold(reason: string, on: boolean): void
}

/**
 * A scripted demo: plays its steps while at least a quarter of it is on screen
 * and the tab is visible, pauses otherwise. Under reduced motion it never
 * plays: it shows its last step (the complete picture) and the visitor steps
 * through by hand.
 */
export function useDemo<E extends HTMLElement>(durations: readonly number[]): Demo<E> {
  const ref = useRef<E>(null)
  const reduced = useReducedMotion()
  const last = durations.length - 1
  const [step, setStep] = useState(() => (reduced ? last : 0))
  const [onScreen, setOnScreen] = useState(false)
  const [tabVisible, setTabVisible] = useState(() => typeof document === 'undefined' || !document.hidden)
  const [holds, setHolds] = useState<ReadonlySet<string>>(() => new Set())
  const playerRef = useRef<StepPlayer | null>(null)
  if (playerRef.current === null) playerRef.current = new StepPlayer(durations, setStep)
  const player = playerRef.current

  useEffect(() => () => player.dispose(), [player])

  useEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setOnScreen(true)
      return
    }
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting), { threshold: 0.25 })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const update = () => setTabVisible(!document.hidden)
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  // Reduced motion: the finished picture.
  useEffect(() => {
    if (reduced) player.goTo(last)
  }, [reduced, player, last])

  const playing = !reduced && onScreen && tabVisible && holds.size === 0
  useEffect(() => {
    if (playing) player.play()
    else player.pause()
  }, [playing, player])

  const goTo = useCallback((index: number) => player.goTo(index), [player])
  const next = useCallback(() => player.goTo(player.index >= player.last ? 0 : player.index + 1), [player])
  const previous = useCallback(() => player.goTo(player.index <= 0 ? player.last : player.index - 1), [player])
  const hold = useCallback((reason: string, on: boolean) => {
    setHolds((current) => {
      if (current.has(reason) === on) return current
      const next = new Set(current)
      if (on) next.add(reason)
      else next.delete(reason)
      return next
    })
  }, [])

  return { ref, step, last, playing, reduced, paused: holds.has('user'), goTo, next, previous, hold }
}

/** For a small loop that is only CSS: whether it should be moving (on screen, tab visible, motion allowed). */
export function useLive<E extends HTMLElement>(): { ref: RefObject<E>; live: boolean; reduced: boolean } {
  const ref = useRef<E>(null)
  const reduced = useReducedMotion()
  const [onScreen, setOnScreen] = useState(false)
  const [tabVisible, setTabVisible] = useState(() => typeof document === 'undefined' || !document.hidden)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setOnScreen(true)
      return
    }
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting), { threshold: 0.2 })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const update = () => setTabVisible(!document.hidden)
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return { ref, live: !reduced && onScreen && tabVisible, reduced }
}
