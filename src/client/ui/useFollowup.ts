/** 追问: the host starts a chat about a finding; the panel then opens that session in DSH's workspace. */
import { useEffect, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Id } from '../../core/types.ts'
import { call, describeError } from '../api.ts'
import { openKnownSession, SessionNavigationError } from '../navigation.ts'
import { useShell } from '../shell/context.ts'

/**
 * `ask()` starts the follow-up of `findingId` and opens its session once DSH lists it. `asking` is true meanwhile;
 * `problem` is what to tell the reader when it did not work (in their words), else null. Leaving the page drops the wait.
 */
export function useFollowup(findingId: Id): { ask: () => Promise<void>; asking: boolean; problem: string | null } {
  const { t, sessions } = useShell()
  const [asking, setAsking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const opening = useRef<AbortController | null>(null)
  useEffect(() => () => { opening.current?.abort() }, [])
  const ask = async () => {
    setAsking(true)
    setProblem(null)
    const controller = new AbortController()
    opening.current = controller
    try {
      const { sessionId } = await call('POST followup', { body: { findingId } })
      if (!sessions) throw new SessionNavigationError('not-ready')
      await openKnownSession(sessions.catalog, sessionId as SessionId, sessions.open, controller.signal)
    } catch (error) {
      setProblem(error instanceof SessionNavigationError ? t(error.code === 'not-ready' ? 'today.sessionNotReady' : 'today.sessionNotListed')
        : describeError(t, error instanceof Error ? error : new Error(String(error))))
    } finally {
      setAsking(false)
    }
  }
  return { ask, asking, problem }
}
