import type { Dimension, DimensionKey } from './types.ts'

/** The dimensions a new track starts with; the user can add custom ones (see `slugDimension`). */
export const DEFAULT_DIMENSIONS: Dimension[] = [
  { key: 'positioning', label: '定位' },
  { key: 'audience', label: '目标人群' },
  { key: 'scenarios', label: '价值场景' },
  { key: 'experience', label: '体验' },
  { key: 'technology', label: '关键技术' },
  { key: 'business', label: '商业化' },
]

/**
 * The English names of the default dimensions (the panel's `dimension.<key>` in src/client/locales.ts, which a test keeps
 * in step): what a chat in English may call them when it looks a dimension up (`outpost_lookup`).
 */
export const DEFAULT_DIMENSION_EN: Readonly<Record<string, string>> = {
  positioning: 'Positioning',
  audience: 'Audience',
  scenarios: 'Use cases',
  experience: 'Experience',
  technology: 'Key technology',
  business: 'Business model',
}

const CUSTOM_PREFIX = 'custom-'
const CUSTOM_HEX_CHARS = 8

/**
 * Key of a custom dimension. A Latin label becomes lower case with every run of non-alphanumerics turned into one `-`
 * ("Pricing Model" -> "pricing-model"). A label that has anything beyond ASCII (Chinese above all), or nothing
 * alphanumeric at all, cannot make a readable key, so it is `custom-` plus the hex code point of each of its first 8
 * characters, four digits apiece (zero-padded) so the codes stay unambiguous when joined.
 */
export function slugDimension(label: string): DimensionKey {
  const lower = label.trim().toLowerCase()
  if (!/[^\x00-\x7f]/.test(lower)) {
    const slug = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    if (slug) return slug
  }
  const hex = [...lower].slice(0, CUSTOM_HEX_CHARS).map((c) => c.codePointAt(0)!.toString(16).padStart(4, '0')).join('')
  return CUSTOM_PREFIX + hex
}
