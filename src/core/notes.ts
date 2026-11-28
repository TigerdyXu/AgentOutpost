/** The user's own notes (M3.3): how long each kind may be, which the host enforces and the panel counts down. */
import type { NoteKind } from './types.ts'

/** Most characters of a note: a product's holds the user's view of it; a finding's, a line or two. */
export const NOTE_MAX: Readonly<Record<NoteKind, number>> = { product: 2000, finding: 500 }
