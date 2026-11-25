/** Bilingual UI dictionaries (`[zh, en]`) of the `outpost` locale namespace. */

const TEXT = {
  panel: ['前哨', 'Outpost'],
  unreadAria: ['今日哨报有 {count} 条新发现未读', '{count} unread findings in today’s brief'],
  configSummary: ['每天定时调研你跟踪的产品，出一份今日哨报。', 'Researches the products you track every day and writes today’s brief.'],
} as const satisfies Record<string, readonly [string, string]>
export type OutpostKey = keyof typeof TEXT
const language = (index: 0 | 1) => Object.fromEntries(Object.entries(TEXT).map(([key, pair]) => [key, pair[index]])) as Record<OutpostKey, string>
export const zh = language(0), en = language(1)
export const NS = 'outpost'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { outpost: OutpostKey }
}
