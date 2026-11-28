/** Words the panel shows that are not its own: the host's fixed sentences, and the names of the default dimensions. */
import { DEFAULT_DIMENSIONS } from '../core/dimensions.ts'
import { heard } from '../core/messages.ts'
import type { Dimension } from '../core/types.ts'
import { COUNTED, type OutpostKey, type T } from './locales.ts'

/**
 * A text the host wrote (a run's reason, a finding's note, an API refusal) in the reader's language: one of its fixed
 * sentences (`heard`) is translated, its `reason` too; any other text (a provider's error, a note the AI wrote) is shown
 * as it is.
 */
export function told(t: T, text: string): string {
  const said = heard(text)
  if (!said) return text
  const { reason, ...rest } = said.params
  const params = reason === undefined ? rest : { ...rest, reason: told(t, reason) }
  return counted(t, `said.${said.key}`, params)
}

/** `t(key, params)`, with the singular line (`<key>.one`) when `params.count` is 1 and the key has one (locales.ts `ONE`). */
export function counted(t: T, key: OutpostKey, params: Record<string, string | number>): string {
  const one = Number(params.count) === 1 && COUNTED.has(key)
  return (t as (key: string, params?: Record<string, string | number>) => string)(one ? `${key}.one` : key, params)
}

const DEFAULT_LABEL = new Map(DEFAULT_DIMENSIONS.map(dimension => [dimension.key, dimension.label] as const))

/** Whether the dimension is one of the six defaults under its default (Chinese) name: then its name follows the reader's language. */
export const isDefaultName = (dimension: Dimension) => DEFAULT_LABEL.get(dimension.key) === dimension.label

/** A dimension's name as shown: a default one under its default name in the reader's language, any other as it was written. */
export function labelOf(t: T, dimension: Dimension): string {
  return isDefaultName(dimension) ? t(`dimension.${dimension.key as 'positioning'}`) : dimension.label
}
