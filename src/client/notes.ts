/**
 * Words the host writes into a finding's `statusNote`, a brief's `skipped` reason or a run's `error`, which the panel acts
 * on. They come from the table both sides share (`src/core/messages.ts`), so they always match what the host writes.
 */
import { say } from '../core/messages.ts'

/** `PROMOTED_NOTE` (host/jobs/verify.ts): a 「待确认」 finding that the check found verified. */
export const PROMOTED = say('promoted')
/** The note `judge` (core/credibility.ts) gives a finding whose source could not be opened. */
export const UNOPENED = say('unopened')
/** `VERIFY_BUDGET_NOTE` (host/jobs/daily.ts): the product ran, but the budget did not allow checking what it found. */
export const VERIFY_BUDGET = say('verifyBudget')
/** `STOPPED_ERROR` (host/jobs/runner.ts): the run failed only because Outpost was stopping, so it was cut short, not broken. */
export const STOPPED = say('stopped')
