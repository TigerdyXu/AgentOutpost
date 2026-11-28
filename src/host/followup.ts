/**
 * 追问 (design §5.2, §7.7): a DSH chat for the user about one finding, on DSH's standard preset (the driver's
 * `startInteractive`), not the research one, and on the follow-up model (`modelFor('followup')`: its own, else the
 * research model, else DSH's default). The session 「追问 · <产品> <标题>」 starts with a
 * message (`prompts/followup.md`) holding the finding, its sources with their quotes, and the summary and points of each
 * of the product's cards; its one Outpost tool is `outpost_read`, for the full dossier. The panel then opens the session.
 */
import { localDate } from '../core/calendar.ts'
import { isOwnSource } from '../core/credibility.ts'
import { modelFor, type ModelSettings } from '../core/models.ts'
import type { Finding, FindingStatus, Id, Product } from '../core/types.ts'
import type { Repo } from '../store/repo.ts'
import type { Clock, IconFetcher, SessionDriver } from './ports.ts'
import { renderPrompt } from './prompts.ts'
import { researchTools } from './tools.ts'
import { sessionTitle } from './titles.ts'

export interface FollowupDeps {
  repo: Repo
  driver: SessionDriver
  clock: Clock
  icons: IconFetcher
  /** The configured models, read when a chat opens. */
  settings: () => ModelSettings
}

const STATUS: Record<FindingStatus, string> = { pending: '待核查', verified: '已核实', unconfirmed: '待确认', unproven: '未证实', withdrawn: '已撤回' }
const IMPORTANCE: Record<Finding['importance'], string> = { major: '重要', notable: '值得留意', minor: '小更新' }

/**
 * Creates the follow-up session for the finding and sends its first message, without waiting for an answer. The session
 * is recorded as a `followup` run (`done`, no cost; its id names the session, `outpost-followup-<8 位>`), so that its
 * tool can be attached again when DSH restarts. A session that could not be opened leaves the run `failed`.
 * @throws When the finding or its product does not exist (nothing is opened), or when the session cannot be opened.
 */
export async function startFollowup(deps: FollowupDeps, findingId: Id): Promise<{ sessionId: string }> {
  const { repo, driver, clock, icons, settings } = deps
  const finding = repo.getFinding(findingId)
  if (!finding) throw new Error(`Unknown finding ${findingId}`)
  const product = repo.getProduct(finding.productId)
  if (!product) throw new Error(`Unknown product ${finding.productId}`)
  const prompt = firstMessage(repo, finding, product)

  const run = repo.createRun({ kind: 'followup', date: localDate(clock.now()), trackId: null, productId: product.id })
  const sessionId = `outpost-followup-${run.id.slice(0, 8)}`
  repo.updateRun(run.id, { status: 'running', sessionId, startedAt: clock.now().toISOString() })
  try {
    await driver.startInteractive({
      sessionId,
      title: sessionTitle(repo, 'followup', { name: product.name, headline: finding.headline }),
      prompt,
      tools: researchTools('followup', { repo, runId: run.id, trackId: null, productId: product.id, now: () => clock.now(), icons, onDone: () => {} }),
      model: modelFor('followup', settings()),
    })
  } catch (error) {
    repo.updateRun(run.id, { status: 'failed', error: error instanceof Error ? error.message : String(error), endedAt: clock.now().toISOString() })
    throw error
  }
  repo.updateRun(run.id, { status: 'done', endedAt: clock.now().toISOString() })
  return { sessionId }
}

function firstMessage(repo: Repo, finding: Finding, product: Product): string {
  const sources = repo.getSources(finding.sourceIds).map((s, i) => {
    const who = [s.publisher, isOwnSource(s) ? '官方' : null, s.publishedAt].filter(Boolean).join(' · ')
    return `  ${i + 1}. 《${s.title}》${who} ${s.url}\n     原话：「${s.quote}」`
  })
  const labels = new Map(repo.dimensionsOfProduct(product.id).map(d => [d.key, d.label]))
  const cards = repo.latestCards(product.id).map(c => [`### ${labels.get(c.dimension) ?? c.dimension}`, c.summary, ...c.bullets.map(b => `- ${b}`)].join('\n'))
  return renderPrompt('followup', {
    productName: product.name,
    company: product.company,
    headline: finding.headline,
    why: finding.why,
    importance: IMPORTANCE[finding.importance],
    status: STATUS[finding.status] + (finding.statusNote ? `（${finding.statusNote}）` : ''),
    sources: sources.join('\n') || '  （没有记录来源）',
    cards: cards.join('\n\n') || '（这个产品还没有档案卡片）',
  })
}
