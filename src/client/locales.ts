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

  // 今日哨报 (design §5.2).
  'weekday.0': ['周日', 'Sun'],
  'weekday.1': ['周一', 'Mon'],
  'weekday.2': ['周二', 'Tue'],
  'weekday.3': ['周三', 'Wed'],
  'weekday.4': ['周四', 'Thu'],
  'weekday.5': ['周五', 'Fri'],
  'weekday.6': ['周六', 'Sat'],
  'today.date': ['{month}月{day}日 · {weekday}', '{weekday}, {month}/{day}'],
  'today.finished': ['{time} 跑完', 'Done at {time}'],
  'today.products': ['{count} 个产品', '{count} products'],
  'today.worth': ['{count} 条值得看', '{count} worth a look'],
  'today.checked': ['每条都过了核查', 'every one checked'],
  'today.unconfirmed': ['{count} 条待确认', '{count} unconfirmed'],
  'today.prev': ['‹ 昨天', '‹ Yesterday'],
  'today.back': ['今天 ›', 'Today ›'],
  'today.readAll': ['全部已读', 'Mark all read'],
  'today.filter': ['按赛道筛选', 'Filter by track'],
  'today.all': ['全部 {count}', 'All {count}'],
  'today.why': ['为什么值得注意：', 'Why it matters: '],
  'today.changed': ['改了档案：', 'Changed in the profile: '],
  'today.list': ['、', ', '],
  'today.look': ['看改动 →', 'See the change →'],
  'today.followup': ['追问', 'Ask more'],
  'today.minor': ['另有 {count} 条小更新，点开看', '{count} more minor updates, open to read'],
  'today.minorHide': ['收起 ↑', 'Collapse ↑'],
  'today.quiet': ['今天没动静：', 'Quiet today: '],
  'today.noNews': ['今天没有值得看的变化', 'Nothing worth a look today'],
  'today.noBrief': ['还没有哨报：前哨每天 {time} 跑完后会出现在这里', 'No brief yet: it appears here after Outpost’s daily run at {time}'],
  'today.noBriefAnyTime': ['还没有哨报：前哨每天跑完后会出现在这里', 'No brief yet: it appears here after Outpost’s daily run'],
  'today.noBriefThatDay': ['这一天没有哨报', 'There is no brief for this day'],
  'today.skipped': ['因预算未跑：{names}（{reason}）', 'Not run, over budget: {names} ({reason})'],
  'today.failed': ['未能更新：{name}（{reason}）', 'Could not update: {name} ({reason})'],
  'today.verifyBudget': ['{name}的新消息核查因预算未完成，明天继续', 'The check of {name}’s news ran out of budget; it continues tomorrow'],
  'today.sessionNotReady': ['追问会话已经建好，但会话列表还没准备好；稍后在 DSH 的会话列表里就能找到。', 'The follow-up session is created, but the session list is not ready; find it in DSH’s session list shortly.'],
  'today.sessionNotListed': ['追问会话已经建好，但会话列表里还没出现；稍后在 DSH 的会话列表里就能找到。', 'The follow-up session is created, but is not in the session list yet; find it in DSH’s session list shortly.'],
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
