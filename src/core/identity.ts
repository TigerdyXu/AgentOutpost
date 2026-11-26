import type { ProductStatus } from './types.ts'

/**
 * Whether two spellings are the same product (design §13 of M1.1): the name and the company are each compared after the
 * full-width and half-width forms are unified (NFKC), upper case is lowered, and everything that is neither a letter nor a
 * digit (spaces, punctuation, hyphens) is dropped (unless that leaves nothing). 「千问Go!」 and 「千问Go」, or 「阶跃 Amoo」
 * and 「阶跃Amoo」, share one key; the same name at another company does not.
 */
export function identityKey(name: string, company: string): string {
  return `${simplified(name)}\u0000${simplified(company)}`
}

/** A name made only of symbols (「★」) would shrink to nothing and match every other one, so it is kept as it is, trimmed. */
const simplified = (text: string) => {
  const unified = text.normalize('NFKC').toLowerCase()
  return unified.replace(/[^\p{L}\p{N}]/gu, '') || unified.trim()
}

/**
 * The statuses of a product Outpost keeps up with (tracking, paused, in 建档中): only such a product counts as the one
 * another spelling is a copy of, and is told to the recommending agent as already followed.
 */
export const FOLLOWED: readonly ProductStatus[] = ['tracking', 'paused', 'baselining']
