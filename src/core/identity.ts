import type { ProductStatus } from './types.ts'

/**
 * Whether two spellings are the same product (design §13 of M1.1): the name and the company are each compared after the
 * full-width and half-width forms are unified (NFKC), upper case is lowered, and spaces and punctuation (hyphens, dashes,
 * brackets, 「!」…) are dropped, unless that leaves nothing. 「千问Go!」 and 「千问Go」, or 「阶跃 Amoo」 and 「阶跃Amoo」,
 * share one key; the same name at another company does not. Symbols stay (the design drops only spaces and punctuation):
 * 「Kimi+」 is not 「Kimi」.
 */
export function identityKey(name: string, company: string): string {
  return `${nameKey(name)}\u0000${simplified(company)}`
}

/** The name half of `identityKey`: how a product typed by name alone is compared, its company not known yet. */
export function nameKey(name: string): string {
  return simplified(name)
}

/**
 * Without spaces (`\s`, `\p{Z}`) and punctuation (`\p{P}`). A name made only of those (「!!!」) would shrink to nothing and
 * match every other one, so it is kept as it is, trimmed.
 */
const simplified = (text: string) => {
  const unified = text.normalize('NFKC').toLowerCase()
  return unified.replace(/[\s\p{Z}\p{P}]/gu, '') || unified.trim()
}

/**
 * The statuses of a product Outpost keeps up with (tracking, paused, in 建档中): only such a product counts as the one
 * another spelling is a copy of, and is told to the recommending agent as already followed.
 */
export const FOLLOWED: readonly ProductStatus[] = ['tracking', 'paused', 'baselining']
