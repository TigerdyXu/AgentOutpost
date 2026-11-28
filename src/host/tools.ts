/**
 * The `outpost_*` tools a research agent calls to hand in its work. Each one checks what it is given against hard limits
 * and the product's own data, writes the result to the store, and answers the agent in plain words. A call that breaks a
 * rule never throws: the agent gets `{ error }` naming the field, fixes it and calls again. Only a bug throws.
 */
import { z } from 'zod'
import { normalizeDate } from '../core/dates.ts'
import { isOwnSource, isValidEvidence, isVoidEvidence } from '../core/credibility.ts'
import { findingKey, isDuplicate, type RecentFinding } from '../core/dedupe.ts'
import { nameKey } from '../core/identity.ts'
import { weeklyHeat } from '../core/hotness.ts'
import type { Id, Source, Span } from '../core/types.ts'
import { canonicalUrl } from '../core/url.ts'
import type { Repo } from '../store/repo.ts'
import type { IconFetcher, ToolSpec } from './ports.ts'
import { say } from '../core/messages.ts'
import { rm } from 'node:fs/promises'

export type RunToolKind = 'recommend' | 'identify' | 'baseline' | 'daily' | 'verify' | 'followup' | 'topic' | 'topicCheck'

/** What a set of tools may touch: the store, the run it belongs to, and the one track and product it is about (if any). */
export interface ToolScope {
  repo: Repo
  runId: Id
  trackId: Id | null
  productId: Id | null
  /** A 专题's research or check (M2.3): the topic, and the draft its cards go into (and are checked from). */
  topicId?: Id | null
  draftId?: Id | null
  now: () => Date
  icons: IconFetcher
  /** The agent said it is finished, with a one-sentence summary. */
  onDone(summary: string): void
}

/** How far back a new finding is compared with earlier ones (and how far back `outpost_read` shows them). */
const RECENT_DAYS = 14
/** How many corroborating sources the verifier may add to one item. */
const MAX_ADDED_SOURCES = 3
const MAX_SOURCES = 8
const MAX_DIMENSIONS = 20
const UNOPENED_NOTE = 'openedVia=unopened：quoteFound/supportsClaim/official 按未知记录'

const TOOL_NAMES: Record<RunToolKind, string[]> = {
  recommend: ['outpost_submit_candidate', 'outpost_done'],
  // One product confirmed by name: the same candidate, handed in once (`buildTools` refuses a second).
  identify: ['outpost_submit_candidate', 'outpost_done'],
  baseline: ['outpost_read', 'outpost_submit_card', 'outpost_submit_facts', 'outpost_done'],
  // No outpost_submit_facts: the key facts are nobody's check (the panel says 「AI 整理 · 未核查」), so only the baseline writes them.
  daily: ['outpost_read', 'outpost_submit_finding', 'outpost_propose_card_edit', 'outpost_done'],
  verify: ['outpost_read_pending', 'outpost_report_check', 'outpost_add_source', 'outpost_done'],
  followup: ['outpost_read'],
  // 专题 (M2.3): the research hands its cards into the round's draft; the check is the dossier's, on that draft.
  topic: ['outpost_read_topic', 'outpost_submit_topic_card', 'outpost_done'],
  topicCheck: ['outpost_read_pending', 'outpost_report_check', 'outpost_done'],
}

/** A 专题 round has at most this many cards (prompts/topic.md asks for 2–6). */
const MAX_TOPIC_CARDS = 6

// ---- argument shapes (the length limits are hard: over them the agent is told to shorten and resubmit) ----
// Optional fields are `.nullish()`: models often send `null` for "nothing here", which means the same as leaving the field out.
// The code reading them treats null and undefined alike. Fields whose null means something of its own (quoteFound) are
// `.nullable()` and stay required.

/** Trimmed text of `min`..`max` characters, with an error that says how far over it is. */
const str = (max: number, min = 1) => z.string().trim()
  .min(min, { error: min === 1 ? '不能为空' : `至少 ${min} 字` })
  .max(max, { error: issue => `不能超过 ${max} 字（现在 ${String(issue.input).length} 字），请缩短后重新提交` })
const url = z.string().trim().url({ protocol: /^https?$/, error: '必须是 http:// 或 https:// 开头的完整网址' })

const SourceInput = z.object({
  url,
  title: str(80),
  publisher: str(30),
  publishedAt: z.string().nullish(),
  kind: z.enum(['official', 'media', 'review', 'appstore', 'social']),
  isOfficial: z.boolean(),
  quote: str(200),
})
type SourceInput = z.infer<typeof SourceInput>

const dimensionKey = str(60)
/** What a card (a first one from the baseline, or a proposed edit) is made of. */
const cardShape = {
  dimension: dimensionKey,
  summary: str(30),
  bullets: z.array(str(40)).min(1).max(3),
  body: str(1500),
  sources: z.array(SourceInput).min(1).max(MAX_SOURCES),
  inferenceQuotes: z.array(str(1500)).max(20).nullish(),
}

const SubmitCandidate = z.object({
  name: str(30),
  company: str(30),
  region: z.enum(['domestic', 'overseas']),
  form: str(20),
  oneLiner: str(40),
  tier: z.enum(['strong', 'consider', 'excluded']),
  reason: str(60),
  officialUrl: url.nullish(),
  iconUrl: url.nullish(),
  articles: z.array(z.object({ url, title: str(80), publishedAt: z.string().nullish() })).min(1).max(50),
})
const SubmitCard = z.object(cardShape)
const SubmitFacts = z.object({ form: str(20, 0), platforms: str(100, 0), price: str(100, 0), firstReleased: str(30, 0), rivals: z.array(str(30)).max(5) })
const SubmitFinding = z.object({
  headline: str(30),
  why: str(80),
  importance: z.enum(['major', 'notable', 'minor']),
  claimKind: z.enum(['self', 'third-party']),
  dimensions: z.array(dimensionKey).max(MAX_DIMENSIONS),
  inference: z.boolean(),
  sources: z.array(SourceInput).min(1).max(MAX_SOURCES),
})
const ProposeCardEdit = z.object({ ...cardShape, changeNote: str(30), findingIds: z.array(str(80)).min(1).max(20) })
const NoArguments = z.object({})
const ReportCheck = z.object({
  sourceId: str(80),
  openedVia: z.enum(['http', 'browser', 'snippet', 'unopened']),
  quoteFound: z.boolean().nullable(),
  supportsClaim: z.boolean().nullable(),
  official: z.boolean().nullable(),
  syndicationGroup: z.string().trim().max(500).nullish(),
})
const AddSource = z.object({ itemId: str(80), source: SourceInput })
const SubmitTopicCard = z.object({
  title: str(20),
  summary: str(40),
  bullets: z.array(str(40)).min(1).max(3),
  body: str(2000),
  sources: z.array(SourceInput).min(1).max(MAX_SOURCES),
  products: z.array(str(30)).min(1).max(8),
  inferenceQuotes: z.array(str(2000)).max(20).nullish(),
})
const Done = z.object({ summary: str(100) })

// ---- plumbing ----

/** A rule the agent broke; its message goes back to the agent as the tool's answer. */
class Rejected extends Error {}
function reject(message: string): never { throw new Rejected(message) }

/** `sources[0].quote` from the path of a zod issue. */
const fieldPath = (path: PropertyKey[]) => path.reduce<string>((acc, part) => typeof part === 'number' ? `${acc}[${part}]` : acc ? `${acc}.${String(part)}` : String(part), '')
const describeIssues = (error: z.ZodError) => error.issues.map(issue => `${fieldPath(issue.path) || '参数'}：${issue.message}`).join('；')

/** A tool whose `execute` checks the arguments itself and turns every rule violation into `{ error }`. */
function tool<S extends z.ZodType>(name: string, description: string, schema: S, run: (args: z.infer<S>) => unknown): ToolSpec {
  return {
    name,
    description,
    schema,
    async execute(raw: unknown) {
      const parsed = schema.safeParse(raw ?? {})
      if (!parsed.success) return { error: `参数有误，请改正后重新调用。${describeIssues(parsed.error)}` }
      try {
        return await run(parsed.data)
      } catch (error) {
        if (error instanceof Rejected) return { error: error.message }
        throw error
      }
    },
  }
}

/** The ranges of `body` that the quotes point at: where each first occurs, overlapping or touching ones merged. */
function inferenceSpans(body: string, quotes: string[]): Span[] {
  const spans = quotes.map(quote => { const start = body.indexOf(quote); return { start, end: start + quote.length } }).sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: Span[] = []
  for (const span of spans) {
    const last = merged.at(-1)
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end)
    else merged.push({ ...span })
  }
  return merged
}

/** `urls` with repeats of the same page (by canonical address) removed; the first spelling of each stays. */
function distinctUrls(urls: string[]): string[] {
  const seen = new Set<string>()
  return urls.filter(u => { const key = canonicalUrl(u); return seen.has(key) ? false : (seen.add(key), true) })
}

function buildTools(kind: RunToolKind, scope: ToolScope): Record<string, ToolSpec> {
  const { repo } = scope
  /** Sources added by `outpost_add_source` so far, per item. */
  const added = new Map<Id, number>()

  const needProduct = (): Id => scope.productId ?? reject('这次运行没有关联产品，不能使用这个工具')
  const needTrack = (): Id => scope.trackId ?? reject('这次运行没有关联赛道，不能使用这个工具')

  const storeSource = (s: SourceInput): Source => repo.addSource({
    url: s.url, title: s.title, publisher: s.publisher, publishedAt: normalizeDate(s.publishedAt ?? undefined), kind: s.kind, isOfficial: s.isOfficial, quote: s.quote,
    syndicationGroup: null, openedVia: null, quoteFound: null, supportsClaim: null, officialConfirmed: null,
  })
  const storeSources = (inputs: SourceInput[]): Source[] => inputs.map(storeSource)

  const checkDimensions = (productId: Id, field: string, keys: string[]) => {
    const own = repo.dimensionsOfProduct(productId).map(d => d.key)
    const unknown = keys.filter(k => !own.includes(k))
    if (unknown.length) reject(`${field}：「${unknown.join('」「')}」不属于这个产品。这个产品的维度只有：${own.join('、') || '（还没有）'}`)
  }

  /** Common checks and the write for a card, whether it is a first card or an edit. */
  const writeCard = (productId: Id, args: z.infer<typeof SubmitCard>, extra: { changeNote: string; findingIds: Id[] }) => {
    checkDimensions(productId, 'dimension', [args.dimension])
    for (const m of args.body.matchAll(/\[(\d+)\]/g)) {
      const n = Number(m[1])
      if (n < 1 || n > args.sources.length) reject(`body：引用了 [${n}]，但 sources 只有 ${args.sources.length} 个（[n] 指 sources 里的第 n 个，从 1 数起）`)
    }
    const quotes = args.inferenceQuotes ?? []
    for (const quote of quotes)
      if (!args.body.includes(quote)) reject(`inferenceQuotes：这一段在 body 里找不到，必须逐字出现在 body 里：「${quote.slice(0, 40)}」`)
    const sources = storeSources(args.sources)
    const edit = repo.addCardEdit({
      productId, dimension: args.dimension, summary: args.summary, bullets: args.bullets, body: args.body, sourceIds: sources.map(s => s.id),
      inferenceSpans: inferenceSpans(args.body, quotes), ...extra,
    })
    return { cardEditId: edit.id }
  }

  /**
   * The product's findings of the last 14 days, in the shape `isDuplicate` compares: with their raw source addresses and
   * what kind of page each is.
   */
  const recentFindings = (productId: Id): RecentFinding[] => repo.findingsOfProduct(productId, RECENT_DAYS).map(f =>
    ({ productId: f.productId, dedupeKey: f.dedupeKey, headline: f.headline, urls: repo.getSources(f.sourceIds).map(s => ({ url: s.url, kind: s.kind, isOfficial: s.isOfficial })) }))

  /** The 专题 of a topic run, and the round its cards go into (M2.3). */
  const needTopic = () => {
    const topic = scope.topicId ? repo.getTopic(scope.topicId) : null
    const draft = scope.draftId ? repo.getTopicVersion(scope.draftId) : null
    if (!topic || !draft || draft.topicId !== topic.id) return reject('这次运行没有关联专题，不能使用这个工具')
    if (draft.status !== 'draft') return reject('这一轮专题已经结束，不能再提交')
    return { topic, draft }
  }
  /** The cards of the round being checked, as the check reads them: like card edits, one item each. */
  const topicItems = () => {
    const { draft } = needTopic()
    return draft.cards.map((card, i) => ({ itemId: `${draft.id}#${i + 1}`, claimKind: null, dimension: card.title, claim: card.summary, detail: card.body, sourceIds: card.sourceIds }))
  }

  /** Everything of this product that waits for a check. */
  const waiting = (productId: Id) => ({
    findings: repo.findingsOfProduct(productId).filter(f => f.status === 'pending'),
    unconfirmed: repo.openUnconfirmed(productId),
    cardEdits: repo.pendingCardEdits(productId),
  })

  /** Looks for an icon in the background; the product gets it when (and if) one turns up. A failed look is no failure. */
  const fetchIconLater = (productId: Id, candidates: string[]) => {
    if (!candidates.length) return
    void Promise.resolve()
      .then(() => scope.icons.fetch(productId, candidates))
      // A product deleted (or merged away) while its icon was being fetched leaves no file behind.
      .then(async path => { if (!path) return; if (repo.getProduct(productId)) repo.setProductIcon(productId, path); else await rm(path, { force: true }) })
      .catch(() => { /* an icon is a nicety: no icon, no problem */ })
  }

  const tools: ToolSpec[] = [
    tool('outpost_submit_candidate',
      '提交一个候选产品（推荐阶段，找到一个就提交一个，不要攒着）。name、company ≤30 字，form ≤20 字，oneLiner ≤40 字，reason ≤60 字；tier 为 strong（强烈推荐）、consider（可以考虑）或 excluded（不推荐，reason 写原因）；articles 至少 1 篇你找到的相关报道（url、title、publishedAt），热度由它们的发布日期算出，不要编数字。officialUrl、iconUrl 知道就填。同一轮里同一个产品只提交一次。成功返回 { candidateId }。',
      SubmitCandidate, args => {
        const trackId = needTrack()
        const [handedIn] = kind === 'identify' ? repo.listCandidates(trackId, scope.runId) : []
        const before = handedIn && repo.getProduct(handedIn.productId)
        if (handedIn) reject(`这次只确认一个产品，已经提交过${before ? `「${before.name}」` : ''}了，不要再提交别的产品。请调用 outpost_done 结束`)
        const officialHost = args.officialUrl ? new URL(args.officialUrl).hostname.toLowerCase().replace(/^www\./, '') : null
        const product = repo.upsertProduct({
          name: args.name, company: args.company, region: args.region, form: args.form, iconPath: null,
          officialDomains: officialHost ? [officialHost] : [], status: 'candidate', dailyBudgetYuan: null,
        })
        if (repo.listCandidates(trackId, scope.runId).some(c => c.productId === product.id)) reject(`name：「${product.name}」这一轮已经提交过了，不要重复提交`)
        const candidate = repo.addCandidate({
          trackId, batchId: scope.runId, productId: product.id, tier: args.tier, oneLiner: args.oneLiner, reason: args.reason,
          heat: weeklyHeat(args.articles.map(a => normalizeDate(a.publishedAt ?? undefined)), scope.now()), selected: args.tier === 'strong',
        })
        const origin = args.officialUrl ? new URL(args.officialUrl).origin : null
        fetchIconLater(product.id, [args.iconUrl, origin && `${origin}/favicon.ico`, origin && `${origin}/apple-touch-icon.png`].filter((u): u is string => !!u))
        return { candidateId: candidate.id }
      }),

    tool('outpost_read',
      '读取这个产品现有的资料：基本信息、维度、关键事实、各维度档案卡片（摘要、要点、正文 body 和它引用的 sources，body 里的 [n] 指 sources 里的第 n 个）、近 14 天已经提交过的发现（标题、状态、时间）、已经引用过的网址。开工前先读一遍：已经报告过的消息不要再提交，哪怕换了说法；已经引用过的文章不要当新来源（更新日志、发布说明、应用商店页、官方博客这类会更新内容的页面上的新条目除外）。无参数。',
      NoArguments, () => {
        const productId = needProduct()
        const product = repo.getProduct(productId) ?? reject('找不到这个产品')
        const facts = repo.latestFacts(productId)
        const recent = repo.findingsOfProduct(productId, RECENT_DAYS)
        const cards = repo.latestCards(productId)
        const known = repo.getSources([...recent.flatMap(f => f.sourceIds), ...cards.flatMap(c => c.sourceIds)])
        return {
          product: { name: product.name, company: product.company, region: product.region, form: product.form, officialDomains: product.officialDomains },
          dimensions: repo.dimensionsOfProduct(productId),
          facts: facts && { form: facts.form, platforms: facts.platforms, price: facts.price, firstReleased: facts.firstReleased, rivals: facts.rivals },
          // The whole card, so that a proposed edit can start from its text and keep its citations; official as the check found it.
          cards: cards.map(c => ({
            dimension: c.dimension, summary: c.summary, bullets: c.bullets, body: c.body,
            sources: repo.getSources(c.sourceIds).map(s => ({ url: s.url, title: s.title, publisher: s.publisher, publishedAt: s.publishedAt, kind: s.kind, isOfficial: isOwnSource(s), quote: s.quote })),
          })),
          recentFindings: recent.map(f => ({ headline: f.headline, status: f.status, createdAt: f.createdAt })),
          knownUrls: distinctUrls(known.map(s => s.url)),
        }
      }),

    tool('outpost_submit_card',
      '建档：提交一个维度的档案卡片。dimension 必须是这个产品的维度（outpost_read 里有）；summary ≤30 字；bullets 1–3 条、每条 ≤40 字；body ≤1500 字，正文里用 [n] 引用 sources 里的第 n 个来源（从 1 数起）；sources 至少 1 个，每个来源的 quote 是原文里的一句原话（1–200 字，逐字抄，不要改写）；你自己归纳、推测的句子，把原句逐字放进 inferenceQuotes（必须在 body 里逐字存在），它们会被标成「推论」。只写有来源支撑的话。成功返回 { cardEditId }；卡片要等核查通过才会生效。',
      SubmitCard, args => writeCard(needProduct(), args, { changeNote: say('profiled'), findingIds: [] })),

    tool('outpost_submit_facts',
      '提交或修改这个产品的关键事实：form（形态，≤20 字）、platforms（平台）、price（价格）、firstReleased（首发时间）各一句话，rivals 最多 5 个竞品名。不知道的写空字符串，不要编。和现有的完全一样就不会新增版本。成功返回 { factsVersion }。',
      SubmitFacts, args => {
        const productId = needProduct()
        const latest = repo.latestFacts(productId)
        if (latest && latest.form === args.form && latest.platforms === args.platforms && latest.price === args.price && latest.firstReleased === args.firstReleased
          && JSON.stringify(latest.rivals) === JSON.stringify(args.rivals)) return { factsVersion: latest.version, unchanged: true }
        return { factsVersion: repo.addFacts({ productId, ...args }).version }
      }),

    tool('outpost_submit_finding',
      '提交一条新发现（日更阶段，一件事一条）。headline ≤30 字，why ≤80 字（为什么值得看）；importance 为 major、notable 或 minor；claimKind 为 self（官方说自己的事）或 third-party（别人的说法）；dimensions 是它涉及的维度（可以为空，必须是这个产品的维度）；inference 表示这是不是你的推论；sources 至少 1 个来源，quote 是原文里的一句原话（1–200 字，逐字抄）。和近 14 天已有的发现重复（同一篇报道、同一个标题，或同一件事换了说法）会被拒绝，并告诉你重复的是哪条；官方页面和应用商店页上的新条目不因网址相同算重复。成功返回 { findingId }；发现要等核查后才会进哨报。',
      SubmitFinding, args => {
        const productId = needProduct()
        checkDimensions(productId, 'dimensions', args.dimensions)
        // One page is one source, however often it is cited: the first citation of it stands (the cards' sources stay as
        // given, since their [n] count them).
        const pages = args.sources.filter((s, i, all) => all.findIndex(o => canonicalUrl(o.url) === canonicalUrl(s.url)) === i)
        const urls = pages.map(s => s.url)
        const cited = pages.map(s => ({ url: s.url, kind: s.kind, isOfficial: s.isOfficial }))
        const twin = recentFindings(productId).find(r => isDuplicate({ productId, headline: args.headline, urls: cited }, [r]))
        if (twin) reject(`这条和已有发现重复：${twin.headline}`)
        const sources = storeSources(pages)
        const finding = repo.addFinding({
          productId, runId: scope.runId, headline: args.headline, why: args.why, importance: args.importance, claimKind: args.claimKind, sourceIds: sources.map(s => s.id),
          status: 'pending', statusNote: null, unconfirmedUntil: null, dimensions: args.dimensions, inference: args.inference, read: false, late: false,
          dedupeKey: findingKey(productId, args.headline, urls), verifiedOn: null,
        })
        return { findingId: finding.id }
      }),

    tool('outpost_propose_card_edit',
      '提议修改某个维度的档案卡片：给出改好之后的完整新文本。字段和 outpost_submit_card 一样（dimension、summary、bullets、body、sources、inferenceQuotes，body 里的 [n] 指本次 sources 里的第 n 个），另加 changeNote ≤30 字（这次改了什么）和 findingIds（依据的发现，至少 1 个，必须是你这次运行用 outpost_submit_finding 提交成功的）。成功返回 { cardEditId }；等依据的发现全部核实后才会生效。',
      ProposeCardEdit, args => {
        const productId = needProduct()
        const mine = new Set(repo.findingsOfProduct(productId).filter(f => f.runId === scope.runId).map(f => f.id))
        const stray = args.findingIds.filter(id => !mine.has(id))
        if (stray.length) reject(`findingIds：${stray.join('、')} 不是你这次运行提交的发现。只能引用本次用 outpost_submit_finding 提交成功的发现`)
        return writeCard(productId, args, { changeNote: args.changeNote, findingIds: [...new Set(args.findingIds)] })
      }),

    tool('outpost_read_pending',
      '核查阶段：读取这个产品等着核查的内容，分三组：pendingFindings（新提交的发现）、pendingCardEdits（待核的卡片修改）、unconfirmedFindings（上次没核实、需要再试的发现）。每条有 itemId、claimKind（self 官方说自己的事，third-party 别人的说法，卡片修改为 null）、claim（要核的话）、detail（补充说明或卡片正文）、sources（每个有 sourceId、url、quote、needsCheck；needsCheck 为 false 的已经核过，不用再打开）。无参数。',
      NoArguments, () => {
        if (scope.topicId) { // a 专题's round: its cards, nothing else
          const settledTopic = (s: Source) => { const seen = { ...s, openedVia: s.openedVia ?? 'unopened' as const }; return isValidEvidence(seen) || isVoidEvidence(seen) }
          return {
            pendingFindings: [], unconfirmedFindings: [],
            pendingCardEdits: topicItems().map(({ sourceIds, ...item }) => ({
              ...item, sources: repo.getSources(sourceIds).map(s => ({ sourceId: s.id, url: s.url, quote: s.quote, needsCheck: !settledTopic(s) })),
            })),
          }
        }
        const { findings, unconfirmed, cardEdits } = waiting(needProduct())
        // A source needs opening until a check has settled it: its quote matched (valid) or its page did not back the claim (void).
        // Never checked, not opened, a search snippet that did not match, an opened page the checker was unsure of: all still open.
        const settled = (s: Source) => { const seen = { ...s, openedVia: s.openedVia ?? 'unopened' as const }; return isValidEvidence(seen) || isVoidEvidence(seen) }
        const sourcesOf = (ids: Id[]) => repo.getSources(ids).map(s => ({ sourceId: s.id, url: s.url, quote: s.quote, needsCheck: !settled(s) }))
        const findingItem = (f: (typeof findings)[number]) => ({ itemId: f.id, claimKind: f.claimKind, claim: f.headline, detail: f.why, sources: sourcesOf(f.sourceIds) })
        return {
          pendingFindings: findings.map(findingItem),
          pendingCardEdits: cardEdits.map(e => ({ itemId: e.id, claimKind: null, dimension: e.dimension, claim: e.summary, detail: e.body, sources: sourcesOf(e.sourceIds) })),
          unconfirmedFindings: unconfirmed.map(findingItem),
        }
      }),

    tool('outpost_report_check',
      '报告你对一个来源的核查结果（每个来源报告一次）。sourceId 取自 outpost_read_pending；openedVia 为 http（直接打开了）、browser（用浏览器打开了）、snippet（只看到搜索摘要）或 unopened（打不开）；quoteFound 表示原文里是否找到了那句引文（没打开过就填 null）；supportsClaim 表示原文是否支持那条结论（不确定就填 null）；official 表示这个页面是不是这个产品的公司自己发布的（官网、帮助中心、官方博客或新闻室、它自己的应用商店页、官方公众号或官方账号填 true；媒体、评测、论坛帖子、别的公司——包括名字相近的另一家——填 false；看不出填 null）；openedVia 为 unopened 时这三项一律按未知（null）记录，不管你填了什么；如果这个来源只是转载别家的通稿，syndicationGroup 填原始通稿的网址。成功返回 { ok: true }。',
      ReportCheck, args => {
        const known = new Set(scope.topicId ? topicItems().flatMap(item => item.sourceIds) : (() => {
          const { findings, unconfirmed, cardEdits } = waiting(needProduct())
          return [...findings, ...unconfirmed].flatMap(f => f.sourceIds).concat(cardEdits.flatMap(e => e.sourceIds))
        })())
        if (!known.has(args.sourceId)) reject(`sourceId：「${args.sourceId}」不在待核查的内容里。只能报告 outpost_read_pending 列出的来源，或者你用 outpost_add_source 新增的来源`)
        // A page nobody opened cannot confirm or deny a quote; kept as sent, `quoteFound: true` would make `judge` count it as valid.
        const unseen = args.openedVia === 'unopened'
        repo.updateSource(args.sourceId, {
          openedVia: args.openedVia, quoteFound: unseen ? null : args.quoteFound, supportsClaim: unseen ? null : args.supportsClaim,
          officialConfirmed: unseen ? null : args.official,
          syndicationGroup: args.syndicationGroup ? canonicalUrl(args.syndicationGroup) : undefined,
        })
        return unseen && (args.quoteFound !== null || args.supportsClaim !== null || args.official !== null) ? { ok: true, note: UNOPENED_NOTE } : { ok: true }
      }),

    tool('outpost_add_source',
      '给一条发现补一个你另外找到的佐证来源（例如第二家独立报道）。itemId 取自 outpost_read_pending 里的发现（卡片修改不能补来源）；source 的字段和提交发现时一样，quote 必须是原文里逐字的一句话。每条发现最多补 3 个。成功返回 { sourceId, remaining }，之后请用 outpost_report_check 报告这个新来源的核查结果。',
      AddSource, args => {
        const productId = needProduct()
        const { findings, unconfirmed, cardEdits } = waiting(productId)
        const item = [...findings, ...unconfirmed].find(f => f.id === args.itemId)
        if (!item) {
          if (cardEdits.some(e => e.id === args.itemId)) reject('itemId：这是一条卡片修改，只有发现可以补来源')
          reject(`itemId：「${args.itemId}」不在待核查的发现里。只能用 outpost_read_pending 列出的发现的 itemId`)
        }
        const used = added.get(args.itemId) ?? 0
        if (used >= MAX_ADDED_SOURCES) reject(`这条发现已经补过 ${MAX_ADDED_SOURCES} 个来源，不能再补了。请报告现有来源的核查结果，然后结束`)
        added.set(args.itemId, used + 1)
        const source = storeSource(args.source)
        repo.updateFinding(item.id, { sourceIds: [...item.sourceIds, source.id] })
        return { sourceId: source.id, remaining: MAX_ADDED_SOURCES - used - 1 }
      }),

    tool('outpost_read_topic',
      '专题：读这个专题。返回 question（要查的问题）、products（涉及的产品，每个有 name、company、officialDomains 和 dossier：档案里各维度的 dimension、summary、bullets）、previous（上一版的卡片，每张有 title、summary、bullets、body、products、sources；没有上一版时为 null）。无参数。',
      NoArguments, () => {
        const { topic } = needTopic()
        const products = topic.productIds.flatMap(id => repo.getProduct(id) ?? [])
        const latest = repo.latestTopicVersion(topic.id)
        const nameOf = (id: Id) => repo.getProduct(id)?.name ?? null
        return {
          question: topic.question,
          products: products.map(p => {
            const labels = new Map(repo.dimensionsOfProduct(p.id).map(d => [d.key, d.label]))
            return {
              name: p.name, company: p.company, officialDomains: p.officialDomains,
              dossier: repo.latestCards(p.id).filter(c => labels.has(c.dimension)).map(c => ({ dimension: labels.get(c.dimension)!, summary: c.summary, bullets: c.bullets })),
            }
          }),
          previous: latest && {
            version: latest.version, createdAt: latest.createdAt,
            cards: latest.cards.map(c => ({
              title: c.title, summary: c.summary, bullets: c.bullets, body: c.body, products: c.productIds.flatMap(id => nameOf(id) ?? []),
              sources: repo.getSources(c.sourceIds).map(s => ({ url: s.url, title: s.title, publisher: s.publisher, publishedAt: s.publishedAt, kind: s.kind, isOfficial: isOwnSource(s), quote: s.quote })),
            })),
          },
        }
      }),

    tool('outpost_submit_topic_card',
      `专题：交一张结论卡片。title ≤20 字（这张卡讲的方面）；summary ≤40 字（一句话结论）；bullets 1–3 条、每条 ≤40 字；body ≤2000 字，每句话后面用 [n] 引用 sources 里的第 n 个来源（从 1 数起）；sources 1–${MAX_SOURCES} 个，quote 是原文里逐字的一句话；products 是这张卡涉及的产品，用 outpost_read_topic 里的名字；你自己的推论、归纳，把原句逐字放进 inferenceQuotes（必须在 body 里逐字存在）。每轮最多 ${MAX_TOPIC_CARDS} 张。成功返回 { cardNumber }；卡片要等核查后才会生效。`,
      SubmitTopicCard, args => {
        const { topic, draft } = needTopic()
        if (draft.cards.length >= MAX_TOPIC_CARDS) reject(`这一轮已经交了 ${MAX_TOPIC_CARDS} 张卡片，不能再交；交完了就调用 outpost_done`)
        for (const m of args.body.matchAll(/\[(\d+)\]/g)) {
          const n = Number(m[1])
          if (n < 1 || n > args.sources.length) reject(`body：引用了 [${n}]，但 sources 只有 ${args.sources.length} 个（[n] 指 sources 里的第 n 个，从 1 数起）`)
        }
        const quotes = args.inferenceQuotes ?? []
        for (const quote of quotes)
          if (!args.body.includes(quote)) reject(`inferenceQuotes：这一段在 body 里找不到，必须逐字出现在 body 里：「${quote.slice(0, 40)}」`)
        const products = topic.productIds.flatMap(id => repo.getProduct(id) ?? [])
        const byName = new Map(products.map(p => [nameKey(p.name), p.id]))
        const unknown = args.products.filter(name => !byName.has(nameKey(name)))
        if (unknown.length) reject(`products：「${unknown.join('」「')}」不是这个专题的产品。只能写：${products.map(p => p.name).join('、')}`)
        const sources = storeSources(args.sources)
        const card = {
          title: args.title, summary: args.summary, bullets: args.bullets, body: args.body, sourceIds: sources.map(s => s.id),
          inferenceSpans: inferenceSpans(args.body, quotes), productIds: [...new Set(args.products.map(name => byName.get(nameKey(name))!))],
        }
        repo.updateTopicVersion(draft.id, { cards: [...draft.cards, card] })
        return { cardNumber: draft.cards.length + 1 }
      }),

    tool('outpost_done',
      '本次任务做完了，调用它结束。summary ≤100 字，一句话说清这次做了什么、没做成什么。所有提交完成之后再调用。',
      Done, args => { scope.onDone(args.summary); return { ok: true } }),
  ]

  return Object.fromEntries(tools.map(t => [t.name, t]))
}

/** The tools one kind of run gets. */
export function researchTools(kind: RunToolKind, scope: ToolScope): ToolSpec[] {
  const all = buildTools(kind, scope)
  return TOOL_NAMES[kind].map(name => all[name]!)
}
