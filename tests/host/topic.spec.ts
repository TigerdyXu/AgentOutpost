import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DIMENSIONS } from '../../src/core/dimensions.ts'
import type { Topic, Track } from '../../src/core/types.ts'
import { JobRunner, type JobDeps, type RuntimeSettings } from '../../src/host/jobs/runner.ts'
import { runTopic, topicDue, topicSchedule } from '../../src/host/jobs/topic.ts'
import { openDb, type Db } from '../../src/store/db.ts'
import { Repo } from '../../src/store/repo.ts'
import { FakeDriver, completed, failure, instantClock, type Play, type Round } from '../fixtures/fake-driver.ts'

const START = new Date(2026, 10, 28, 9, 0, 0)
const TODAY = '2026-11-28'
const RESEARCH = 'outpost-topic-'
const CHECK = 'outpost-topicCheck-'

let dir: string
let db: Db
let repo: Repo
let driver: FakeDriver
let time: ReturnType<typeof instantClock>
let deps: JobDeps
let track: Track
let topic: Topic

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outpost-topic-'))
  db = openDb(join(dir, 'outpost.sqlite'))
  time = instantClock(START)
  repo = new Repo(db, () => time.clock.now())
  driver = new FakeDriver()
  const settings: RuntimeSettings = { maxParallel: 3, dailyBudgetYuan: 20, sessionTimeoutMin: 30, model: { provider: 'deepseek', model: 'research' }, verifyModel: { provider: 'deepseek', model: 'check' }, briefModel: null, followupModel: null, billingFor: () => 'metered', pricesOf: () => ({ inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.04 }) }
  const runner = new JobRunner({ repo, driver, clock: time.clock, settings: () => settings, log: vi.fn() })
  deps = { repo, runner, clock: time.clock, icons: { fetch: vi.fn(async () => null) } }
  track = repo.createTrack({ name: 'Personal Agent', brief: '', dimensions: DEFAULT_DIMENSIONS.slice(0, 2), status: 'active' })
  for (const [id, name, company] of [['p1', '小豆', '字节跳动'], ['p2', 'Muse', 'Meta']] as const) {
    repo.upsertProduct({ id, name, company, region: 'domestic', form: 'App', iconPath: null, officialDomains: [`${id}.example`], status: 'tracking', dailyBudgetYuan: null })
    repo.linkProduct(track.id, id)
  }
  repo.addCardVersion({ productId: 'p1', dimension: 'positioning', version: 1, summary: '独立的个人代理', bullets: ['替你办事'], body: '正文', sourceIds: [], inferenceSpans: [], addedSpans: [], changeNote: '建档', findingIds: [], createdAt: START.toISOString() })
  topic = repo.createTopic({ trackId: track.id, question: '谁能记住用户的偏好', productIds: ['p1', 'p2'], cadence: 'weekly' })
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const source = (url: string, quote = `${url} 的原话`) => ({ url, title: '报道', publisher: '某媒体', publishedAt: null, kind: 'media', isOfficial: false, quote })
const card = (title: string, urls: string[], over: Record<string, unknown> = {}) => ({
  title, summary: `${title}的结论`, bullets: [`${title}要点[1]`], body: urls.map((_, i) => `第 ${i + 1} 句。[${i + 1}]`).join(''), sources: urls.map(u => source(u)),
  products: ['小豆', 'Muse'], ...over,
})
/** A research session that reads the topic, hands in these cards and ends with `summary`. */
const research = (cards: ReturnType<typeof card>[], summary = '查了记忆能力', seen: { read?: unknown } = {}): Play => async (r: Round) => {
  seen.read = await r.call('outpost_read_topic')
  for (const c of cards) await r.call('outpost_submit_topic_card', c)
  await r.done(summary)
  return completed()
}
interface Pending { pendingCardEdits: { itemId: string; claim: string; sources: { sourceId: string; url: string; needsCheck: boolean }[] }[] }
/** A check that finds the quote on every page except those `missing` says (opened, quote not there: void). */
const check = (missing: (url: string) => boolean = () => false): Play => async (r: Round) => {
  const pending = await r.call('outpost_read_pending') as Pending
  for (const item of pending.pendingCardEdits) for (const s of item.sources)
    await r.call('outpost_report_check', { sourceId: s.sourceId, openedVia: 'http', quoteFound: !missing(s.url), supportsClaim: missing(s.url) ? null : true, official: false })
  await r.done()
  return completed()
}

describe('runTopic (M2.3)', () => {
  it('researches, checks, and writes the cards that held as version 1, the researcher’s summary as what it changed', async () => {
    const seen: { read?: unknown } = {}
    driver.script[RESEARCH] = research([card('记什么', ['https://a.example/1', 'https://b.example/2']), card('能不能删', ['https://c.example/3'])], '查了记什么、能不能删', seen)
    driver.script[CHECK] = check(url => url.includes('c.example'))

    const version = await runTopic(deps, topic.id, TODAY)

    expect(version).toMatchObject({ topicId: topic.id, version: 1, status: 'final', changeNote: '查了记什么、能不能删' })
    expect(version!.cards.map(c => c.title)).toEqual(['记什么']) // 能不能删 rested on one source, which the check found void
    expect(version!.cards[0]!.productIds).toEqual(['p1', 'p2'])
    expect(repo.latestTopicVersion(topic.id)?.id).toBe(version!.id)
    expect(seen.read).toMatchObject({
      question: '谁能记住用户的偏好', previous: null,
      products: [{ name: '小豆', company: '字节跳动', dossier: [{ dimension: '定位', summary: '独立的个人代理', bullets: ['替你办事'] }] }, { name: 'Muse', dossier: [] }],
    })
    const runs = repo.runsOfDate(TODAY)
    expect(runs.map(r => [r.kind, r.status, r.trackId, r.subject])).toEqual([['topic', 'done', track.id, topic.question], ['topicCheck', 'done', track.id, topic.question]])
    expect(driver.runs[1]!.prompt).toContain('字节跳动、Meta') // the dossier's checker, told whose pages count as official
    expect(driver.runs.map(spec => spec.model?.model)).toEqual(['research', 'check']) // on the models chosen for research and checks
    // The two void sources of the card dropped whole are cited by nothing any more: gone with the round, not left behind.
    expect(repo.getSources(version!.cards[0]!.sourceIds)).toHaveLength(2)
    expect(db.prepare("SELECT count(*) AS n FROM sources WHERE url LIKE 'https://c.example/%'").get()).toMatchObject({ n: 0 })
  })

  it('writes nothing, and does not fail, for a topic deleted while its round runs', async () => {
    driver.script[RESEARCH] = async r => {
      await r.call('outpost_submit_topic_card', card('记什么', ['https://a.example/1']))
      repo.deleteTopic(topic.id) // the user deleted it meanwhile
      await r.done()
      return completed()
    }
    driver.script[CHECK] = check()
    await expect(runTopic(deps, topic.id, TODAY)).resolves.toBeNull()
    expect(repo.topicVersions(topic.id)).toEqual([])
  })

  it('stops trying by itself after three rounds in a row with no version, until one is asked for', async () => {
    driver.script[RESEARCH] = research([])
    for (const day of ['2026-11-28', '2026-11-29', '2026-11-30']) {
      time.set(new Date(`${day}T10:00:00`))
      await runTopic(deps, topic.id, day)
    }
    expect(topicSchedule(repo, topic, '2026-12-01')).toEqual({ last: null, next: null, gaveUp: true })
    expect(topicDue(repo, topic, '2026-12-01')).toBe(false)
    driver.script[RESEARCH] = research([card('记什么', ['https://a.example/1'])])
    driver.script[CHECK] = check()
    time.set(new Date('2026-12-01T10:00:00'))
    await runTopic(deps, topic.id, '2026-12-01') // 立即更新
    expect(topicSchedule(repo, topic, '2026-12-01')).toMatchObject({ last: '2026-12-01', gaveUp: false })
  })

  it('builds the next version on the last, told to the researcher', async () => {
    driver.script[RESEARCH] = research([card('记什么', ['https://a.example/1'])])
    driver.script[CHECK] = check()
    await runTopic(deps, topic.id, TODAY)
    const seen: { read?: unknown } = {}
    driver.script[RESEARCH] = research([card('记什么', ['https://a.example/1']), card('跨设备', ['https://d.example/4'])], '补上跨设备', seen)
    const second = await runTopic(deps, topic.id, '2026-12-05')
    expect(second).toMatchObject({ version: 2, changeNote: '补上跨设备' })
    expect(seen.read).toMatchObject({ previous: { version: 1, cards: [{ title: '记什么', products: ['小豆', 'Muse'], sources: [{ url: 'https://a.example/1' }] }] } })
    expect(driver.runs[2]!.prompt).toContain('第 2 版')
  })

  it('makes no version, and says why, when nothing held, nothing was handed in, or a session did not finish', async () => {
    driver.script[RESEARCH] = research([card('记什么', ['https://a.example/1'])])
    driver.script[CHECK] = check(() => true)
    expect(await runTopic(deps, topic.id, TODAY)).toBeNull()
    expect(repo.topicVersions(topic.id).at(-1)).toMatchObject({ status: 'rejected', changeNote: '核查后没有一张卡片站得住' })

    driver.script[RESEARCH] = research([])
    expect(await runTopic(deps, topic.id, TODAY)).toBeNull()
    expect(repo.topicVersions(topic.id).at(-1)).toMatchObject({ status: 'rejected', changeNote: '调研没有交卡片' })

    driver.script[RESEARCH] = () => failure('模型返回了无法解析的内容')
    expect(await runTopic(deps, topic.id, TODAY)).toBeNull()
    expect(repo.topicVersions(topic.id).at(-1)).toMatchObject({ status: 'rejected', changeNote: '模型返回了无法解析的内容' })
    expect(repo.latestTopicVersion(topic.id)).toBeNull()
  })

  it('refuses a card naming another product, citing a source it does not have, or beyond six', async () => {
    const answers: unknown[] = []
    driver.script[RESEARCH] = async r => {
      answers.push(await r.call('outpost_submit_topic_card', card('甲', ['https://a.example/1'], { products: ['Cue'] })))
      answers.push(await r.call('outpost_submit_topic_card', card('乙', ['https://a.example/1'], { body: '一句。[2]' })))
      for (let i = 0; i < 7; i++) answers.push(await r.call('outpost_submit_topic_card', card(`卡${i}`, [`https://a.example/${i}`])))
      await r.done()
      return completed()
    }
    driver.script[CHECK] = check()
    await runTopic(deps, topic.id, TODAY)
    expect(answers[0]).toMatchObject({ error: expect.stringContaining('「Cue」不是这个专题的产品') })
    expect(answers[1]).toMatchObject({ error: expect.stringContaining('引用了 [2]') })
    expect(answers.slice(2, 8)).toEqual([1, 2, 3, 4, 5, 6].map(cardNumber => ({ cardNumber })))
    expect(answers[8]).toMatchObject({ error: expect.stringContaining('已经交了 6 张') })
  })

  it('is due weekly after its newest version, a one-off only until it has one, and once a day', async () => {
    expect(topicSchedule(repo, topic, TODAY)).toEqual({ last: null, next: TODAY, gaveUp: false })
    expect(topicDue(repo, topic, TODAY)).toBe(true)
    driver.script[RESEARCH] = research([card('记什么', ['https://a.example/1'])])
    driver.script[CHECK] = check()
    await runTopic(deps, topic.id, TODAY)
    expect(topicSchedule(repo, topic, TODAY)).toEqual({ last: TODAY, next: '2026-12-05', gaveUp: false })
    expect(topicDue(repo, topic, '2026-12-05')).toBe(true)
    const once = repo.updateTopic(topic.id, { cadence: 'once' })
    expect(topicSchedule(repo, once, '2026-12-05')).toEqual({ last: TODAY, next: null, gaveUp: false })

    const fresh = repo.createTopic({ trackId: track.id, question: '谁收费', productIds: ['p1'], cadence: 'once' })
    driver.script[RESEARCH] = research([])
    await runTopic(deps, fresh.id, TODAY) // did not make it: tried again tomorrow
    expect(topicSchedule(repo, fresh, TODAY)).toEqual({ last: null, next: '2026-11-29', gaveUp: false })
    expect(topicSchedule(repo, repo.createTopic({ trackId: track.id, question: '新的', productIds: ['p1'], cadence: 'once' }), TODAY, true).next).toBe('2026-11-29')
  })
})

describe('topics in the store (M2.3)', () => {
  it('reject the drafts an Outpost that did not stop cleanly left behind', () => {
    const draft = repo.addTopicDraft(topic.id)
    repo.rejectTopicDrafts('前哨已停止')
    expect(repo.getTopicVersion(draft.id)).toMatchObject({ status: 'rejected', changeNote: '前哨已停止' })
  })

  it('keep a source a topic still cites when a product that also cited it is deleted', () => {
    const shared = repo.addSource({ url: 'https://shared.example/', title: 't', publisher: 'p', publishedAt: null, kind: 'media', isOfficial: false, quote: 'q', syndicationGroup: null, openedVia: null, quoteFound: null, supportsClaim: null, officialConfirmed: null })
    repo.addCardVersion({ productId: 'p2', dimension: 'positioning', version: 1, summary: 's', bullets: ['b'], body: 'b[1]', sourceIds: [shared.id], inferenceSpans: [], addedSpans: [], changeNote: '建档', findingIds: [], createdAt: START.toISOString() })
    const draft = repo.addTopicDraft(topic.id)
    repo.updateTopicVersion(draft.id, { status: 'final', version: 1, cards: [{ title: 't', summary: 's', bullets: ['b'], body: 'b[1]', sourceIds: [shared.id], inferenceSpans: [], productIds: ['p1'] }] })
    repo.deleteProduct('p2')
    expect(repo.getSources([shared.id])).toHaveLength(1)
  })

  it('lose a deleted product, and go with their last one or their track, with the sources only they cite', async () => {
    driver.script[RESEARCH] = research([card('记什么', ['https://a.example/1'])])
    driver.script[CHECK] = check()
    const version = await runTopic(deps, topic.id, TODAY)
    const cited = version!.cards[0]!.sourceIds
    const alone = repo.createTopic({ trackId: track.id, question: '只关于 Muse', productIds: ['p2'], cadence: 'once' })
    expect(repo.topicsOfProduct('p2').map(t => t.id)).toEqual([topic.id, alone.id])

    repo.deleteProduct('p2')
    expect(repo.getTopic(topic.id)?.productIds).toEqual(['p1'])
    expect(repo.getTopic(alone.id)).toBeNull()
    expect(repo.getSources(cited)).toHaveLength(1) // still cited by the topic

    repo.deleteTrack(track.id)
    expect(repo.getTopic(topic.id)).toBeNull()
    expect(repo.topicVersions(topic.id)).toEqual([])
    expect(repo.getSources(cited)).toEqual([])
  })
})
