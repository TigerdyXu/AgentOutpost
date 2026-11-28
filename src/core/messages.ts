/**
 * The fixed sentences the host writes that the panel may show (a run's reason, a finding's note, a refusal of the API),
 * each in Chinese and English. The host writes the Chinese one (`say`), as it always has, so the database keeps Chinese
 * text and older rows read the same; the panel recognises a stored or answered text (`heard`) and shows it in the
 * reader's language. A text it does not recognise (a provider's own error, a note the AI wrote) is shown as it is.
 *
 * `{name}` is a parameter. A parameter called `reason` is itself a sentence of this table (or any text), so the panel
 * translates it too. Pure: the panel imports it.
 */

export const SAID = {
  // Why work did not start: the budget.
  budgetTotal: ['今日总预算已用完', 'Today’s total budget is used up'],
  budgetProduct: ['该产品今日预算已用完', 'This product’s budget for today is used up'],
  budgetToday: ['今日预算已用完', 'Today’s budget is used up'],
  budgetInvalid: ['每日预算设置无效', 'The daily budget setting is not valid'],

  // How a run ended.
  stopped: ['前哨已停止', 'Outpost was stopping'],
  runFailed: ['运行失败', 'The run failed'],
  notDone: ['提醒后仍没有调用 outpost_done，按已提交的内容收尾', 'It did not call outpost_done even after a reminder; what it handed in stands'],
  retried: ['{reason}（已重试 {count} 次）', '{reason} (tried again {count} times)'],
  timeout: ['超过 {minutes} 分钟没有结束，已停止', 'Stopped after running longer than {minutes} minutes'],
  blocked: ['会话被拦下，没有继续', 'The session was blocked and did not go on'],
  aborted: ['会话被取消', 'The session was cancelled'],
  sessionError: ['会话出错', 'The session ran into an error'],
  stoppedEarly: ['会话没有调用 outpost_done 就停了，这次不下结论', 'The session stopped without calling outpost_done, so there is no verdict this time'],
  checkSkipped: ['核查被跳过', 'The check was skipped'],
  checkFailed: ['核查失败', 'The check failed'],
  checkNotDone: ['核查没有完成：{reason}', 'The check did not finish: {reason}'],
  verifyBudget: ['核查因预算未完成', 'The check ran out of budget'],
  noCards: ['没有提交任何档案卡', 'No profile cards were handed in'],
  identifyNotFound: ['没有找到这个产品', 'This product could not be found'],
  settleFailed: ['处理结果时出错', 'Something went wrong while handling the result'],
  unusableGist: ['模型给的总结是空的或超过 {max} 字，改用第一条发现的标题', 'The model’s summary was empty or longer than {max} characters, so the first finding’s headline is used'],
  noNews: ['今天没有值得看的变化', 'Nothing worth a look today'],
  presetBroken: ['前哨的调研预设加载不了，推荐、建档、核查和日更都跑不了。详情在桌面版的日志里。',
    'Outpost’s research presets do not load, so recommendations, profiles, checks and daily updates cannot run. The details are in the Desktop’s log.'],
  modelsUnreadable: ['读取失败', 'Could not be read'],
  modelAborted: ['模型调用已中止（超时或前哨停止）', 'The model call was stopped (it timed out, or Outpost was stopping)'],
  dataDirLocked: ['数据目录被另一个前哨进程占用：{dir}', 'The data directory is in use by another Outpost process: {dir}'],
  internal: ['前哨内部出错，详情见 DSH 日志', 'Something went wrong inside Outpost; the details are in the DSH log'],
  notJson: ['请求必须是 JSON', 'The request must be JSON'],

  // A card's first version (its change note), and a finding's note from the check.
  profiled: ['建档', 'Profile built'],
  quoteUnsupported: ['引句在原文中找不到或不支持结论', 'The quote is not in the source, or does not support the claim'],
  unopened: ['原文打不开', 'The source could not be opened'],
  oneSource: ['只有一个来源', 'Only one source'],
  promoted: ['已证实', 'Confirmed'],

  // Refusals of the API.
  trackNotFound: ['找不到这个赛道', 'Cannot find this track'],
  productNotFound: ['找不到这个产品', 'Cannot find this product'],
  findingNotFound: ['找不到这条发现', 'Cannot find this finding'],
  noteSubjectNotFound: ['只能给产品或发现写笔记', 'Notes go on a product or a finding'],
  noteTooLong: ['笔记最多 {max} 字', 'A note is at most {max} characters'],
  runNotFound: ['找不到这次运行', 'Cannot find this run'],
  noBriefThatDay: ['这一天没有哨报', 'There is no brief for this day'],
  noIcon: ['这个产品没有图标', 'This product has no icon'],
  notFollowed: ['这个产品没有在跟踪', 'Outpost is not following this product'],
  trackArchived: ['这个赛道已归档', 'This track is archived'],
  alreadyInTrack: ['它已经在这个赛道里了', 'It is already in this track'],
  notInTrack: ['它不在这个赛道里', 'It is not in this track'],
  onlyTrack: ['这是它唯一的赛道。不想跟了就用「暂停跟踪」或「删除产品」。', 'This is its only track. To stop following it, pause tracking or delete the product.'],
  recommending: ['上一轮推荐还在进行，稍等它结束再调整', 'The last round of suggestions is still running; adjust once it is over'],
  candidateNotOfTrack: ['候选 {id} 不是这个赛道的', 'Candidate {id} is not one of this track’s'],
  pauseAfterBaseline: ['建档完成后才能暂停或恢复跟踪', 'Tracking can be paused or resumed once the profile is built'],
  resumeFirst: ['这个产品没有在跟踪，先恢复跟踪再更新', 'This product is not being tracked; resume tracking before updating it'],
  retryFailedOnly: ['只有失败的运行可以重试', 'Only a failed run can be retried'],
  alreadyRetried: ['已经重新跑过了', 'It has already been run again'],
  recommendNoTrack: ['这次推荐不属于任何赛道，没法重试', 'This recommendation belongs to no track, so it cannot be retried'],
  followupNoRetry: ['追问不能重试，请从哨报里重新点「追问」', 'A follow-up cannot be retried; press “Ask more” in the brief again'],
  noRetry: ['这种运行不能重试', 'This kind of run cannot be retried'],
  productBusy: ['「{name}」正在建档、更新或核查，等它跑完再删', '“{name}” is being profiled, updated or checked; delete it once that is over'],
  trackBusy: ['这个赛道的推荐或产品确认还在进行，等它跑完再删', 'This track’s suggestions or a product confirmation are still running; delete it once they are over'],
  nameTaken: ['已经有一个「{name}」在跟踪了。想合并的话，删掉其中一个', 'Outpost already follows “{name}”. To merge them, delete one of the two'],
  dimensionsNeeded: ['至少留一个维度', 'Keep at least one dimension'],
  dimensionTwice: ['维度「{label}」重复了', 'The dimension “{label}” is listed twice'],
  dimensionUnknown: ['维度 {key} 不是这个赛道的', 'The dimension {key} is not one of this track’s'],
  siteInvalid: ['「{site}」不是网址或域名', '“{site}” is not a web address or domain'],
  // M2.1: the track's map.
  unusableRecap: ['模型给的周回顾总结用不了（空的，或超过 {max} 字），这次没有写', 'The model’s weekly summary could not be used (empty, or over {max} characters), so none was written'],
  unusableMap: ['模型给的地图用不了（格式不对、少了产品，或格局超过 {max} 字），这次没有更新', 'The model’s map could not be used (malformed, a product missing, or the summary over {max} characters), so it was not updated'],
  mapNeedsProducts: ['至少要有两个建好档的产品，才画得出地图', 'A map needs at least two products with a profile'],
  mapDrawing: ['地图正在画，等它画完', 'The map is being drawn; wait for it to finish'],
  // M2.2
  dismissNotStarted: ['这个赛道还在挑产品，挑好开始跟踪就行', 'This track is still being picked; start following from it instead'],
  // M2.3: 专题.
  topicNoProducts: ['专题涉及的产品都删掉了', 'Every product of the topic was deleted'],
  topicNoCards: ['调研没有交卡片', 'The research handed in no cards'],
  topicNothingHeld: ['核查后没有一张卡片站得住', 'No card held up under the check'],
  topicFirst: ['首版', 'First version'],
  topicUpdated: ['更新了一版', 'Updated'],
  topicBusy: ['这个专题正在深挖，等它跑完', 'This topic is being looked into; wait for it to finish'],
  topicNotFound: ['找不到这个专题', 'Cannot find this topic'],
  topicProductNotInTrack: ['产品 {id} 不在这个赛道里', 'Product {id} is not in this track'],
} as const satisfies Record<string, readonly [string, string]>

export type SaidKey = keyof typeof SAID
type Params = Record<string, string | number>

const fill = (template: string, params: Params) => template.replace(/\{(\w+)\}/g, (whole, name: string) => name in params ? String(params[name]) : whole)

/** The host's words: the Chinese sentence of `key`, with its parameters filled in. */
export function say(key: SaidKey, params: Params = {}): string {
  return fill(SAID[key][0], params)
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const EXACT = new Map<string, SaidKey>()
const PATTERNS: { key: SaidKey; names: string[]; re: RegExp }[] = []
for (const key of Object.keys(SAID) as SaidKey[]) {
  const template = SAID[key][0]
  const names = [...template.matchAll(/\{(\w+)\}/g)].map(m => m[1]!)
  if (!names.length) { EXACT.set(template, key); continue }
  const source = template.split(/\{\w+\}/).map(escape).join('([\\s\\S]+?)')
  PATTERNS.push({ key, names, re: new RegExp(`^${source}$`) })
}

/**
 * The sentence of the table that `text` is (the key, and its parameters as written), or null when it is none of them:
 * exactly one without parameters first, else the first one whose pattern it fits.
 */
export function heard(text: string): { key: SaidKey; params: Record<string, string> } | null {
  const exact = EXACT.get(text)
  if (exact) return { key: exact, params: {} }
  for (const { key, names, re } of PATTERNS) {
    const m = re.exec(text)
    if (m) return { key, params: Object.fromEntries(names.map((name, i) => [name, m[i + 1]!])) }
  }
  return null
}
