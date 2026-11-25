import { useEffect, useRef, type RefObject } from 'react'

/** Calls `onLeave` once the element has been in the viewport and then is not; never while `done`, nor where the browser has no observer. */
export function useLeaveViewport(ref: RefObject<Element | null>, done: boolean, onLeave: () => void): void {
  const latest = useRef(onLeave)
  latest.current = onLeave
  useEffect(() => {
    const element = ref.current
    if (done || !element || typeof IntersectionObserver === 'undefined') return
    let seen = false
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) seen = true
        else if (seen) { observer.disconnect(); latest.current(); return }
      }
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [ref, done])
}
