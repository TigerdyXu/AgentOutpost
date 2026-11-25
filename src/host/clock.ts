/**
 * The wall clock, for the real host. `at` does not set one long timer: Node's timers count only the time the machine is
 * awake, so on a laptop that slept through 08:00 a timer set the evening before would go off hours late. Instead it looks
 * at the wall clock again at least every `CLOCK_STEP_MS`, and fires within that step after the machine wakes up.
 */
import type { Clock } from './ports.ts'

/** The longest a timer waits before it looks at the wall clock again. */
export const CLOCK_STEP_MS = 60_000

export class SystemClock implements Clock {
  /** @param onError - told about a callback that threw; default `console.warn`. A throw from a timer would end the host. */
  constructor(private readonly onError: (error: unknown) => void = error => console.warn('dsh-outpost: a timer failed:', error)) {}

  now(): Date { return new Date() }

  /** Runs `fn` once, on a later turn of the event loop, as soon as the wall clock reads `when` or later. */
  at(when: Date, fn: () => void): () => void {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const wait = () => {
      const left = when.getTime() - Date.now()
      timer = setTimeout(check, Math.max(0, Math.min(left, CLOCK_STEP_MS)))
      timer.unref?.() // a pending timer is no reason to keep the process alive
    }
    const check = () => {
      if (!live) return
      if (Date.now() < when.getTime()) return wait()
      live = false
      try { fn() } catch (error) { this.onError(error) }
    }
    wait()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }
}
