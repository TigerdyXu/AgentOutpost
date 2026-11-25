/** Bilingual UI dictionaries (`[zh, en]`) of the `outpost` locale namespace. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

const TEXT = {
  panel: ['前哨', 'Outpost'],
  unreadAria: ['今日哨报有 {count} 条新发现未读', '{count} unread findings in today’s brief'],
  configSummary: ['每天定时调研你跟踪的产品，出一份今日哨报。', 'Researches the products you track every day and writes today’s brief.'],

  // The middle column (design §5.1).
  'nav.label': ['前哨导航', 'Outpost navigation'],
  'nav.toggle': ['前哨菜单', 'Outpost menu'],
  'nav.newTrack': ['＋ 新赛道', '＋ New track'],
  'nav.today': ['今日哨报', 'Today’s brief'],
  'nav.todayNew': ['{count} 条新', '{count} new'],
  'nav.todayNone': ['还没有', 'None yet'],
  'nav.picking': ['挑选中', 'Picking'],
  'nav.pick': ['挑产品', 'Pick products'],
  'nav.picked': ['已选 {count}', '{count} picked'],
  'nav.candidates': ['候选推荐', 'Suggestions'],
  'nav.candidatesWaiting': ['{count} 条待看', '{count} to review'],
  'nav.baselining': ['建档中', 'Building profile'],
  'nav.progress': ['{done}/{total}', '{done}/{total}'],
  'nav.paused': ['已暂停', 'Paused'],
  'nav.new': ['有新发现', 'New findings'],
  'nav.runs': ['运行记录', 'Runs'],
  'nav.todayCost': ['今天 ¥{amount}', 'Today ¥{amount}'],
  'nav.settings': ['设置', 'Settings'],

  // What the panel says when it cannot read its state.
  'error.starting': ['前哨正在启动…', 'Outpost is starting…'],
  'error.request': ['请求失败（{status}）', 'Request failed ({status})'],

  // The right column before the first track, and pages still to come.
  'welcome.title': ['先建一个赛道', 'Start with a track'],
  'welcome.body': ['说说你关注哪个领域，前哨会推荐值得盯的产品，每天早上给你一份今日哨报。', 'Name a field you follow; Outpost suggests the products worth watching and writes you a brief every morning.'],
  'welcome.action': ['＋ 新建第一个赛道', '＋ Create your first track'],
  'page.newTrack': ['新建赛道', 'New track'],
  'page.product': ['产品档案', 'Product profile'],

  // Labels on findings, cards and sources (design §5.2, §5.4, §8).
  'tag.official': ['官方', 'Official'],
  'tag.inference': ['推论', 'Inference'],
  'tag.ai': ['AI 归纳', 'AI summary'],
  'tag.fresh': ['今天改过', 'Changed today'],
  'tag.unconfirmed': ['待确认', 'Unconfirmed'],
  'tag.unopened': ['原文打不开', 'Source unreachable'],
  'tag.late': ['迟到', 'Late'],
  'tag.major': ['重要', 'Major'],
  'tag.notable': ['值得留意', 'Notable'],
  'tag.promoted': ['已证实', 'Confirmed'],

  'source.open': ['打开原文：{title}', 'Open the source: {title}'],
} as const satisfies Record<string, readonly [string, string]>
export type OutpostKey = keyof typeof TEXT
const language = (index: 0 | 1) => Object.fromEntries(Object.entries(TEXT).map(([key, pair]) => [key, pair[index]])) as Record<OutpostKey, string>
export const zh = language(0), en = language(1)
export const NS = 'outpost'
/** The translate function of the `outpost` namespace, as the slots hand it to the panel. */
export type T = TranslateNS<typeof NS>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { outpost: OutpostKey }
}
