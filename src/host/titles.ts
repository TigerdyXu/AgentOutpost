/**
 * The titles of the sessions Outpost opens in DSH, in the language of the user's panel (DSH's language setting, which the
 * panel reports: `POST language`). DSH's session list shows them; before the panel has said, they are Chinese.
 */
import type { Repo } from '../store/repo.ts'

/** Settings key: the panel's language, `zh` or `en` (`POST language`). */
export const UI_LANGUAGE = 'uiLanguage'

const TITLES = {
  baseline: ['前哨 · {name} 建档', 'Outpost · {name} · profile'],
  baselineCheck: ['前哨 · {name} 建档核查', 'Outpost · {name} · profile check'],
  daily: ['前哨 · {name} 日更 {date}', 'Outpost · {name} · daily {date}'],
  verify: ['前哨 · {name} 核查 {date}', 'Outpost · {name} · check {date}'],
  recommend: ['前哨 · 推荐 {track}', 'Outpost · suggestions · {track}'],
  identify: ['前哨 · 确认产品 {name}', 'Outpost · confirm {name}'],
  topic: ['前哨 · 专题 {question}', 'Outpost · topic · {question}'],
  topicCheck: ['前哨 · 专题核查 {question}', 'Outpost · topic check · {question}'],
  followup: ['追问 · {name} {headline}', 'Follow-up · {name} · {headline}'],
  // Not a session: the card of one outpost_lookup call in another chat (M3.1).
  lookup: ['查前哨 · {subject}', 'Outpost lookup · {subject}'],
} as const satisfies Record<string, readonly [string, string]>
export type TitleKey = keyof typeof TITLES

/** A session's title in the panel's language. */
export function sessionTitle(repo: Repo, key: TitleKey, params: Record<string, string>): string {
  const english = repo.getSetting<string>(UI_LANGUAGE) === 'en'
  return TITLES[key][english ? 1 : 0].replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? '')
}
