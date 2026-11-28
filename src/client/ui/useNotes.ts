/** The user's notes on a page's findings (M3.3): what the host sent, with what was saved on this page since on top. */
import { useCallback, useState } from 'react'
import type { Id, Note } from '../../core/types.ts'

export function useNotes(sent: Readonly<Record<Id, Note>> | undefined) {
  const [own, setOwn] = useState<Readonly<Record<Id, Note | null>>>({})
  const noteOf = (id: Id): Note | null => id in own ? own[id]! : sent?.[id] ?? null
  const saved = useCallback((id: Id, note: Note | null) => { setOwn(previous => ({ ...previous, [id]: note })) }, [])
  return { noteOf, saved }
}
