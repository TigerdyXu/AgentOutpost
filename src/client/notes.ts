/**
 * Words the host writes into a finding's `statusNote` or a brief's `skipped` reason, which the panel acts on. They are
 * copies (the panel must not import the host's modules, which reach for Node); tests/client/today.spec.tsx keeps each
 * equal to its source.
 */

/** `PROMOTED_NOTE` (host/jobs/verify.ts): a 「待确认」 finding that the check found verified. */
export const PROMOTED = '已证实'
/** The note `judge` (core/credibility.ts) gives a finding whose source could not be opened. */
export const UNOPENED = '原文打不开'
/** `VERIFY_BUDGET_NOTE` (host/jobs/daily.ts): the product ran, but the budget did not allow checking what it found. */
export const VERIFY_BUDGET = '核查因预算未完成'
