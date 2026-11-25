import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOCK_STEP_MS, SystemClock } from '../../src/host/clock.ts'

const HOUR = 60 * 60 * 1000

beforeEach(() => { vi.useFakeTimers({ now: new Date(2026, 10, 24, 22, 0, 0) }) })
afterEach(() => { vi.useRealTimers() })

describe('SystemClock', () => {
  it('tells the wall-clock time', () => {
    expect(new SystemClock().now()).toEqual(new Date(2026, 10, 24, 22, 0, 0))
  })

  it('runs the callback at the time asked, not before', () => {
    const fn = vi.fn()
    new SystemClock().at(new Date(2026, 10, 25, 8, 0, 0), fn)
    vi.advanceTimersByTime(10 * HOUR - 1)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(24 * HOUR)
    expect(fn).toHaveBeenCalledOnce() // once
  })

  it('fires soon after a sleep that carried the machine past the time', () => {
    // A laptop closed at 22:00 and opened at 09:00: timers count only awake time (they keep their delay across the jump),
    // but the wall clock moved on. One 10-hour timer would fire around 19:00; checking every minute fires within a minute.
    const fn = vi.fn()
    new SystemClock().at(new Date(2026, 10, 25, 8, 0, 0), fn)
    vi.advanceTimersByTime(5 * 60_000)
    vi.setSystemTime(new Date(2026, 10, 25, 9, 0, 0)) // asleep: wall clock jumps, pending timers stay as they were
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(CLOCK_STEP_MS)
    expect(fn).toHaveBeenCalledOnce()
    expect(CLOCK_STEP_MS).toBeLessThanOrEqual(60_000)
  })

  it('never runs the callback inside `at`, even for a time already past', () => {
    const fn = vi.fn()
    new SystemClock().at(new Date(2026, 10, 24, 21, 0, 0), fn)
    expect(fn).not.toHaveBeenCalled() // the caller may still be setting up (the scheduler stores the cancel function first)
    vi.advanceTimersByTime(0)
    expect(fn).toHaveBeenCalledOnce()
  })

  it('cancels: nothing runs after the returned function is called, however long it waits', () => {
    const fn = vi.fn()
    const cancel = new SystemClock().at(new Date(2026, 10, 25, 8, 0, 0), fn)
    vi.advanceTimersByTime(3 * CLOCK_STEP_MS)
    cancel()
    vi.advanceTimersByTime(24 * HOUR)
    expect(fn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports a callback that throws instead of letting it take the host down', () => {
    const onError = vi.fn()
    new SystemClock(onError).at(new Date(2026, 10, 24, 22, 0, 1), () => { throw new Error('boom') })
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }))
  })
})
