# 前哨 M1「先能用」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做出能装进 dsh 桌面版的「前哨」插件第一期：建一个赛道 → AI 推荐 → 勾选 → 建档 → 每天定时增量调研、核查、出今日哨报；能看产品档案、追问、运行记录和设置。

**Architecture:** 一个 dsh「前后两半」插件包（照 superagent）。后台一半是 Cordis 插件：纯逻辑放 `src/core`（不依赖 dsh，单测全覆盖），数据放 `node:sqlite`，所有 dsh 交互收在两个适配器（`DshSessionDriver`、`DshModelClient`）里，流程（推荐 / 建档 / 日更 / 核查 / 汇总）只依赖接口，用假实现测。前端一半是注册到 dsh 插槽的 React 面板，经 `/outpost/api/*` 轮询后台。

**Tech Stack:** TypeScript 6、Node 24（`node:sqlite`）、Cordis + Schemastery、zod 4、React 18、tsdown、vitest 4 + jsdom、`diff`（字符级差异）。

**Spec:** `docs/设计文档.md`（已定稿）。草图：`docs/mockups/*.html`。执行者两份都要读。M1 范围见设计文档 §10；赛道页（矩阵、定位地图）、专题、候选每周刷新属于 M2，不在本计划。M2 的定位地图要「建档那天的位置」：M1 保留每个维度的第 1 版卡片（带日期），M2 据此补算，所以 M1 不用存地图位置。

## Global Constraints

- dsh 目标版本 0.2.3-alpha.2（桌面版与源码 `4b399c39a6` 已对齐）。`package.json`：`"engines": { "node": ">=24", "dsh": ">=0.2.3-alpha.2 <0.3.0" }`；所有 `@deepseek-ai/*` peer 与 dev 依赖钉在 0.2.3-alpha.2 对应版本（版本号从 dsh 源码对应包的 `package.json` / `vendor/*/package.json` 读，不要抄 superagent 的 0.2.1）。
- 名字固定：npm 包 `dsh-outpost`；client 模块 id `dsh-outpost`；主面板 / 侧栏 id `outpost`；locale 命名空间 `outpost`；HTTP 前缀 `/outpost`，接口在 `/outpost/api/`；工具名前缀 `outpost_`；agent 预设 id `outpost-researcher`；会话 id 前缀 `outpost-`；CSS 类名前缀 `op-`。
- 配置 `dataDir` 必填、绝对路径；用户本机取值 `/Users/tiger/Projects/AgentOutpost-data`。数据库文件 `<dataDir>/outpost.sqlite`，图标 `<dataDir>/icons/`，会话工作目录 `<dataDir>/workspace/`（dsh 工作区标题「前哨」）。
- 前端包：不写动态 `import()`；`neverBundle` 为 `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`zod`；不用 clsx；dsh 的 `@deepseek-ai/*` 只做 `import type`（`dsh-client-ui-primitives` 若要用值，加进 `neverBundle`）。
- 样式：单个 `src/client/styles.css` 以 `?raw` 导入、`<style>` 注入；只用 `--dsw-*` / `--dsh-*` 变量，不写颜色字面量；中性边框 0.5px；高层级表面用 `box-shadow: var(--dsw-elevation-panel)` 且 `border: 0`；选中态＝浅蓝底（`--dsw-alias-state-business-tertiary`）＋蓝字（`--dsw-alias-link`）＋加粗，**不要左侧竖条**；阅读正文字号 `max(15px, var(--dsh-content-font-size))`；右栏内容铺满剩余宽度，不设居中窄栏。
- 界面文案逐字用设计文档里的：「今日哨报」「＋ 新赛道」「n 条新」「看改动 →」「追问」「全部已读」「‹ 昨天」「今天没动静：」「今天没有值得看的变化」「待确认」「原文打不开」「推论」「AI 归纳」「今天改过」「官方」「迟到」「强烈推荐」「可以考虑」「全选这一组」「稍后再挑」「开始跟踪 n 个」「建档中」「全部展开」「立即更新」「展开」「收起 ↑」「这一节怎么变过来的」「运行记录」「设置」。
- 默认值：每日 `08:00`（全局一个时间）；同时跑 3 个产品；汇总截止＝开始后 2 小时；待确认期限 7 天；新加文字高亮 72 小时；日更读取近 14 天的发现；单会话超时 30 分钟；临时错误重试 3 次、间隔 15 秒；补找佐证每条发现最多 3 次搜索、打开 3 个网页；研究会话 7 天后归档。
- 可信度规则逐字按设计文档 §8（官方说自己的事 1 个来源够；别人的说法要 2 个独立来源；同一通稿转载算 1 个；打不开 ≠ 假，摘要对上原话算核实）。
- 联网：图标等二进制用 Node `fetch`（宿主已装全局代理分发器）；网页正文用 `ctx.web.fetch`。
- 测试：vitest，`tests/**/*.spec.{ts,tsx}`；前端测试文件头 `// @vitest-environment jsdom`，用 `react-dom/client` 的 `createRoot` + `act`，`globalThis.IS_REACT_ACT_ENVIRONMENT = true`（照 superagent `tests/client.spec.tsx`）。`pnpm check` = typecheck + test + build。
- 每个任务结束 `git commit`，信息末尾带 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。不提交 `.superpowers/`、`lib/`、`node_modules/`。

## Review Focus

1. **桌面版 08:00 没开着**（合盖、关机），14:00 才打开 → 立刻补跑一次，当天只有一份哨报；跑到一半被退出 → 下次启动只补没跑完的产品。测试在 Task 10（`scheduler.spec.ts` 的 `catches up once after a missed run` 和 `resumes only unfinished products`）。
2. **某产品几周都没新闻，或当天全部没动静** → 不凑数：没动静的只在末尾点名；全部没有时只显示「今天没有值得看的变化」，侧栏数字不显示。测试在 Task 4（`brief.spec.ts`）和 Task 13（`today.spec.tsx`）。
3. **浏览器兜底没开、原文在公众号** → 发现标「待确认」＋「原文打不开」，不撤回；设置页说明怎么开。测试在 Task 2（`credibility.spec.ts`）、Task 9（`verify.spec.ts`）、Task 16（`settings.spec.tsx`）。
4. **预算跑到一半用完** → 剩下的产品不跑、不报错，哨报写「因预算未跑：…」。测试在 Task 8（`runner.spec.ts`）和 Task 10（`daily-flow.spec.ts`）。
5. **同一条新闻被多家转载，或第二天被重复提交** → 只出现一次。测试在 Task 4（`dedupe.spec.ts`）和 Task 6（`tools.spec.ts` 的 `rejects a duplicate finding`）。

---

## 文件结构

```
package.json  tsconfig.json  tsdown.config.ts  vitest.config.ts  cordis.patch.yml
dev/overlay.cordis.yml            开发用 overlay（--patch 不会应用包自带的 bundle patch）
dev/README.md                     开发与安装命令
prompts/  recommend.md baseline.md daily.md verify.md synthesize.md followup.md
src/index.ts                      宿主入口：name / inject / Config / apply
src/config.ts                     Schemastery Config 与 RuntimeSettings
src/core/                         纯逻辑，不 import 任何 @deepseek-ai 包
  types.ts dimensions.ts credibility.ts calendar.ts cost.ts brief.ts cards.ts hotness.ts dedupe.ts
src/store/                        db.ts（打开、迁移、atomic） migrations.ts repo.ts
src/host/
  ports.ts                        SessionDriver / ModelClient / Clock / ToolSpec 接口
  dsh-sessions.ts dsh-model.ts    dsh 适配器
  tools.ts icons.ts prompts.ts followup.ts scheduler.ts runtime.ts api.ts http.ts
  jobs/ runner.ts recommend.ts baseline.ts daily.ts verify.ts synthesize.ts
src/client/
  index.tsx api.ts locales.ts styles.css css.d.ts
  shell/ App.tsx MiddleColumn.tsx route.ts
  ui/ ProductIcon.tsx Tag.tsx SourceChip.tsx Citation.tsx
  pages/ Today.tsx NewTrack.tsx Product.tsx Runs.tsx Settings.tsx
  pages/product/ DossierTab.tsx FeedTab.tsx SourcesTab.tsx
tests/  core/ store/ host/ client/ fixtures/
```

---

### Task 1: 开发环境与能加载的空插件

**Files:**
- Create: `package.json`、`tsconfig.json`、`tsdown.config.ts`、`vitest.config.ts`、`cordis.patch.yml`、`dev/overlay.cordis.yml`、`dev/README.md`、`src/index.ts`、`src/config.ts`、`src/host/http.ts`、`src/client/index.tsx`、`src/client/css.d.ts`、`src/client/styles.css`、`src/client/locales.ts`
- Test: `tests/client/register.spec.tsx`、`tests/host/http.spec.ts`、`tests/build.spec.ts`

**Interfaces:**
- Produces:
  - `src/config.ts`：`export const Config`（Schemastery）字段：`dataDir: string`（必填、`/^\//`）、`runTime: Volatile<string>`（默认 `'08:00'`，`/^\d{2}:\d{2}$/`）、`maxParallel: Volatile<number>`（默认 3，1–8）、`dailyBudgetYuan: Volatile<number>`（默认 20）、`sessionTimeoutMin: Volatile<number>`（默认 30）、`model: Volatile<{ provider: string; model: string } | null>`（默认 null＝用户默认模型）、`prices: Volatile<{ inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok: number }>`。`export type OutpostConfig = ReturnType<typeof Config>`。价格默认值在实现时从 DeepSeek 官方价格页查当前模型的单价（元 / 百万 token），注释写明网址和查询日期，界面上的花费一律标「估算」。
  - `src/index.ts`：`export const name = 'dsh-outpost'`；`export const inject = ['agents','sessionController','sessionPersistence','workspaceRegistry','tools','systemPrompt','webServer','llm','web','agentDefaultModel']`；`export { Config }`；`export async function apply(ctx: Context, config: OutpostConfig): Promise<void>`。本任务只注册健康检查路由。
  - `src/host/http.ts`：`export function registerRoutes(ctx: Context, handle: (route: string, req: ApiRequestParts) => Promise<unknown>): () => void`；`interface ApiRequestParts { method: string; path: string; params: Record<string,string>; query: Record<string,string>; body: () => Promise<unknown> }`。用 `ctx.webServer.register({ kind: 'prefix', path: '/outpost', handler })`，`auth` 用默认 `required`；非 `/outpost/api/` 返回 404；请求体上限 128 KiB；JSON 响应头照 superagent `src/app/http.ts:72-74`；错误映射：zod 错误 400、`ApiError(status)` 用自身状态、其他 500。图标、正文以外一律 JSON。
  - `src/client/index.tsx`：`export const inject = ['slots','locale','sessions','uiWorkspace']`；`export function apply(ctx)` 注册 `main`（key `outpost`）、`sidebar.panellist`（id `outpost`、order 20、label「前哨」、望远镜图标）、`sidebar.panellist.trailing`（id `outpost`，组件读注入的未读数，0 时返回 null，>99 显示 `99+`，数字 `aria-hidden` 旁边放视觉隐藏的完整句子；写法照 dsh `packages/experimental/client-ui-forge/src/client/review-page/ReviewNav.tsx:21-47`）、`plugins.row.config`（key `dsh-outpost#outpost`）。本任务主面板只渲染「前哨」标题。

- [ ] **Step 1: 准备开发环境**

装 Node ≥24.22.3（Homebrew 用 `HOMEBREW_NO_AUTO_UPDATE=1 brew install node@24` 或官方安装包）和 pnpm 11（`corepack enable && corepack prepare pnpm@11.28.5 --activate`）。在 dsh 源码目录后台运行 `pnpm install && pnpm run build`（很慢，放后台）。
Run: `node --version && pnpm --version && cd /Users/tiger/workspace/DeepSeek/Harness/deepseek-harness && git rev-parse --short HEAD`
Expected: `v24.22.3` 或更高、`11.x`、`4b399c39a6`

- [ ] **Step 2: 写包配置**

照 superagent 的 `package.json` / `tsconfig.json` / `tsdown.config.ts`（见其仓库根目录），改：包名、`exports`（`.`、`./client`、`./package.json`）、`files`（加 `prompts`）、`dsh.bundle.patch`、`dsh.client.platform: "web"`、engines 与依赖版本（Global Constraints）、client 构建的 banner id 改 `dsh-outpost`、`neverBundle` 加 `react-dom/client` 和 `zod`。dependencies：`zod`、`diff`。`cordis.patch.yml` 插入 `dsh-outpost` 一行（不带 dataDir，dataDir 由 profile 或 overlay 给），并定义 `outpost-researcher` 预设（`@deepseek-ai/dsh-agent-preset`，plugins：`dsh-persona`（prefix「You are a product research analyst powered by the {{model}} model.」）、`dsh-time-context`、`dsh-tool-web`（`fetch: true`、`searchTimeoutMs: 60000`）、压缩组照 superagent；**不要** shell、fs 工具）；再插入 `@deepseek-ai/dsh-browser-use` 和 `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp`（`mode: launch`、`headless: true`）两行，都 `disabled: true`。`dev/overlay.cordis.yml` 用绝对路径插入同样的行，并给 `dataDir: /Users/tiger/Projects/AgentOutpost-data/dev`。

- [ ] **Step 3: 写失败的测试**

```ts
// tests/client/register.spec.tsx
it('registers main, sidebar entry, trailing count and plugin config row', () => {
  const { entries } = fixture()   // 照 superagent tests/client.spec.tsx 的 fixture
  expect(entries.map(e => e.options.name)).toEqual(['main','sidebar.panellist','sidebar.panellist.trailing','plugins.row.config'])
  expect(entries[1].options).toMatchObject({ id: 'outpost', order: 20, locale: 'outpost' })
  expect(entries[3].options).toMatchObject({ key: 'dsh-outpost#outpost' })
})
it('trailing count renders nothing at 0 and 99+ above 99', async () => { /* 渲染 0 → 空；150 → 文本含 '99+' */ })
// tests/host/http.spec.ts
it('answers GET /outpost/api/health with {ok:true}', async () => { /* 假 webServer.register 捕获 handler，直接调用 */ })
it('returns 404 outside /outpost/api/ and 400 for a non-JSON body', async () => {})
// tests/build.spec.ts（先跑 pnpm build）
it('wraps lib/client.js in the dsh module loader', () => {
  const text = readFileSync('lib/client.js', 'utf8')
  expect(text.startsWith('window.__ModuleLoader__.load({ id: "dsh-outpost", factory: (require) => {')).toBe(true)
  expect(text).not.toMatch(/require\.async|import\(/)
})
```

- [ ] **Step 4: 跑测试确认失败**
Run: `pnpm test`
Expected: FAIL（模块不存在）

- [ ] **Step 5: 实现上面 Produces 里的入口、Config、路由和面板注册**

- [ ] **Step 6: 跑检查**
Run: `pnpm check`
Expected: typecheck、全部测试、build 通过

- [ ] **Step 7: 在开发版 dsh 里看到它**
Run: `cd /Users/tiger/workspace/DeepSeek/Harness/deepseek-harness && DSH_HOME=$HOME/.dsh-outpost pnpm dsh web --patch /Users/tiger/Projects/AgentOutpost/dev/overlay.cordis.yml`
Expected: 浏览器里侧栏出现「前哨」（望远镜图标），点开显示「前哨」标题；`curl --noproxy '*'` 打 `/outpost/api/health`（带页面同源会话）返回 `{"ok":true}`。把命令写进 `dev/README.md`。

- [ ] **Step 8: Commit**
`git add -A && git commit -m "feat: 前哨插件骨架，可在开发版 dsh 加载"`

---

### Task 2: 领域类型、默认维度与可信度判定

**Files:**
- Create: `src/core/types.ts`、`src/core/dimensions.ts`、`src/core/credibility.ts`
- Test: `tests/core/credibility.spec.ts`

**Interfaces:**
- Produces（`src/core/types.ts`，后续所有任务都用这些名字）：
```ts
export type Id = string                              // crypto.randomUUID()
export type DimensionKey = string
export interface Dimension { key: DimensionKey; label: string }
export interface Track { id: Id; name: string; brief: string; dimensions: Dimension[]; status: 'picking'|'active'|'archived'; createdAt: string }
export type ProductStatus = 'candidate'|'baselining'|'tracking'|'paused'|'archived'
export interface Product { id: Id; name: string; company: string; region: 'domestic'|'overseas'; form: string; iconPath: string|null; officialDomains: string[]; status: ProductStatus; dailyBudgetYuan: number|null; createdAt: string }
export interface Heat { foundCount: number; datedWeekly: number[]; trend: 'up'|'flat'|'down'|'unknown'; showBars: boolean }
export type CandidateTier = 'strong'|'consider'|'excluded'
export interface Candidate { id: Id; trackId: Id; batchId: Id; productId: Id; tier: CandidateTier; oneLiner: string; reason: string; heat: Heat; selected: boolean }
export type SourceKind = 'official'|'media'|'review'|'appstore'|'social'
export type OpenedVia = 'http'|'browser'|'snippet'|'unopened'
export interface Source { id: Id; url: string; title: string; publisher: string; publishedAt: string|null; kind: SourceKind; isOfficial: boolean; quote: string; syndicationGroup: string|null; openedVia: OpenedVia|null; quoteFound: boolean|null; supportsClaim: boolean|null }
export type Importance = 'major'|'notable'|'minor'
export type ClaimKind = 'self'|'third-party'
export type FindingStatus = 'pending'|'verified'|'unconfirmed'|'unproven'|'withdrawn'
export interface Finding { id: Id; productId: Id; runId: Id; headline: string; why: string; importance: Importance; claimKind: ClaimKind; sourceIds: Id[]; status: FindingStatus; statusNote: string|null; unconfirmedUntil: string|null; dimensions: DimensionKey[]; inference: boolean; read: boolean; late: boolean; dedupeKey: string; createdAt: string }
export interface Span { start: number; end: number }
export interface CardVersion { productId: Id; dimension: DimensionKey; version: number; summary: string; bullets: string[]; body: string; sourceIds: Id[]; inferenceSpans: Span[]; addedSpans: Span[]; changeNote: string; findingIds: Id[]; createdAt: string }
export interface CardEdit { id: Id; productId: Id; dimension: DimensionKey; summary: string; bullets: string[]; body: string; sourceIds: Id[]; inferenceSpans: Span[]; changeNote: string; findingIds: Id[]; status: 'pending'|'applied'|'rejected' }
export interface Facts { productId: Id; version: number; form: string; platforms: string; price: string; firstReleased: string; rivals: string[]; createdAt: string }
export interface Brief { date: string; gist: string; findingIds: Id[]; minorIds: Id[]; quietProductIds: Id[]; skipped: { productId: Id; reason: string }[]; costYuan: number; createdAt: string; updatedAt: string }
export type RunKind = 'recommend'|'baseline'|'daily'|'verify'|'synthesize'|'followup'
export type RunStatus = 'queued'|'running'|'done'|'failed'|'skipped'
export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number }
export interface Run { id: Id; kind: RunKind; date: string; trackId: Id|null; productId: Id|null; sessionId: string|null; status: RunStatus; startedAt: string|null; endedAt: string|null; usage: Usage; costYuan: number; error: string|null; progress: { done: number; total: number }|null }
```
  - `src/core/dimensions.ts`：`export const DEFAULT_DIMENSIONS: Dimension[]` ＝ `positioning 定位`、`audience 目标人群`、`scenarios 价值场景`、`experience 体验`、`technology 关键技术`、`business 商业化`；`export function slugDimension(label: string): DimensionKey`（自定义维度：小写、非字母数字转 `-`；中文直接用 `custom-` + 前 8 个字符的十六进制码）。
  - `src/core/credibility.ts`：
```ts
export interface Evidence { url: string; isOfficial: boolean; syndicationGroup: string|null; openedVia: OpenedVia; quoteFound: boolean|null; supportsClaim: boolean|null }
export interface Verdict { status: FindingStatus; note: string|null; unconfirmedUntil: string|null }
export function judge(input: { claimKind: ClaimKind; evidence: Evidence[]; firstSeen: Date; now: Date }): Verdict
```
判定顺序：①打开了（`http`/`browser`）但 `quoteFound === false` 或 `supportsClaim === false` 的来源作废；②有效来源＝`quoteFound === true` 且 `supportsClaim !== false`（含 `snippet`）；③全部来源都作废 → `withdrawn`，note「引句在原文中找不到或不支持结论」；④独立数＝有效来源按 `syndicationGroup ?? 规范化 URL（host+path）` 去重计数；⑤`self` 且有效来源里有 `isOfficial` → `verified`；⑥独立数 ≥ 2 → `verified`；⑦否则：`now` 超过 `firstSeen + 7 天` → `unproven`，否则 `unconfirmed`，`unconfirmedUntil = firstSeen + 7 天`，note 有 `unopened` 来源时为「原文打不开」，否则「只有一个来源」。

- [ ] **Step 1: 写失败的测试**
```ts
it('verifies a self claim backed by one confirmed official source', () =>
  expect(judge({ claimKind: 'self', evidence: [ev({ isOfficial: true, openedVia: 'http', quoteFound: true })], firstSeen: d0, now: d0 }).status).toBe('verified'))
it('keeps a third-party claim with one source unconfirmed for 7 days', () => {
  const v = judge({ claimKind: 'third-party', evidence: [ev({ openedVia: 'http', quoteFound: true })], firstSeen: d0, now: d0 })
  expect(v).toEqual({ status: 'unconfirmed', note: '只有一个来源', unconfirmedUntil: plusDays(d0, 7).toISOString() })
})
it('counts reposts of one press release once', () =>
  expect(judge({ claimKind: 'third-party', evidence: [ev({ syndicationGroup: 'pr-1', quoteFound: true, openedVia: 'http' }), ev({ syndicationGroup: 'pr-1', quoteFound: true, openedVia: 'http', url: 'https://b.com/x' })], firstSeen: d0, now: d0 }).status).toBe('unconfirmed'))
it('verifies a third-party claim with two independent sources', () => {})
it('accepts a search-snippet match as a confirmed source', () => {})
it('marks an unopenable source 原文打不开 instead of withdrawing', () => {
  const v = judge({ claimKind: 'self', evidence: [ev({ isOfficial: true, openedVia: 'unopened', quoteFound: null })], firstSeen: d0, now: d0 })
  expect(v.status).toBe('unconfirmed'); expect(v.note).toBe('原文打不开')
})
it('withdraws when every opened source lacks the quote', () => {})
it('turns unconfirmed into unproven after 7 days', () => {})
```
- [ ] **Step 2: Run** `pnpm vitest run tests/core/credibility.spec.ts` → Expected: FAIL
- [ ] **Step 3: 实现 types、dimensions、`judge`**
- [ ] **Step 4: Run** 同上 → Expected: PASS
- [ ] **Step 5: Commit** `feat(core): 领域类型与可信度判定`

---

### Task 3: 时间与费用

**Files:**
- Create: `src/core/calendar.ts`、`src/core/cost.ts`
- Test: `tests/core/calendar.spec.ts`、`tests/core/cost.spec.ts`

**Interfaces:**
- Produces:
  - `localDate(d: Date): string`（本地时区 `YYYY-MM-DD`）
  - `nextRunAt(now: Date, runTime: string): Date`（今天该时刻若已过则明天）
  - `shouldCatchUp(now: Date, runTime: string, lastCompletedDailyDate: string|null): boolean`（已过今天该时刻且今天没完成过）
  - `cutoffAt(start: Date): Date`（+2 小时）
  - `interface PriceTable { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok: number }`
  - `costOf(u: Usage, p: PriceTable): number`（元，保留 4 位小数；`inputTokens` 指未命中缓存的输入）
  - `canSpend(a: { spentToday: number; dailyBudget: number; productSpentToday: number; productBudget: number|null }): { ok: true } | { ok: false; reason: string }`，reason 为「今日总预算已用完」或「该产品今日预算已用完」

- [ ] **Step 1: 写失败的测试**：`nextRunAt` 在 07:59、08:00、23:00 三种时刻；`shouldCatchUp` 在 14:00 且昨天完成 → true，今天已完成 → false，07:00 → false；`costOf` 用 1,000,000 输入 token 等于 `inputPerMTok`；`canSpend` 两种拒绝原因。
- [ ] **Step 2: Run** `pnpm vitest run tests/core/calendar.spec.ts tests/core/cost.spec.ts` → FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4: Run** 同上 → PASS
- [ ] **Step 5: Commit** `feat(core): 运行时间与费用计算`

---

### Task 4: 哨报编排、档案卡版本、热度、去重

**Files:**
- Create: `src/core/brief.ts`、`src/core/cards.ts`、`src/core/hotness.ts`、`src/core/dedupe.ts`
- Test: `tests/core/brief.spec.ts`、`tests/core/cards.spec.ts`、`tests/core/hotness.spec.ts`、`tests/core/dedupe.spec.ts`

**Interfaces:**
- Produces:
  - `composeBrief(input: { date: string; findings: Finding[]; trackedProductIds: Id[]; skipped: Brief['skipped']; gist: string; costYuan: number; now: Date; previous: Brief|null }): Brief`。只收 `verified` 与 `unconfirmed`；排序：`major` > `notable`，同级 `verified` 在前，再按 `createdAt`；`minor` 进 `minorIds`；`quietProductIds` ＝ 跟踪中但当天没有任何发现（不论重要程度）的产品；`previous` 存在时保留 `createdAt`。
  - `NO_NEWS_GIST = '今天没有值得看的变化'`
  - `unreadCount(brief: Brief, findings: Map<Id, Finding>): number`（`findingIds` 中未读的条数）
  - `applyCardEdit(prev: CardVersion|null, edit: Pick<CardEdit,'summary'|'bullets'|'body'|'sourceIds'|'inferenceSpans'|'changeNote'|'findingIds'> & { productId: Id; dimension: DimensionKey }, now: Date): CardVersion`。`version = (prev?.version ?? 0) + 1`；`addedSpans` 用 `diff` 包的 `diffChars(prev?.body ?? '', edit.body)` 算出新增区间（`prev` 为 null 时为空数组，建档不高亮）。
  - `isFresh(card: CardVersion, now: Date): boolean`（72 小时内）
  - `weeklyHeat(dates: (string|null)[], now: Date): Heat`：`foundCount = dates.length`；最近 5 周按周分桶（旧→新）；有日期的 <5 → `showBars: false, trend: 'unknown'`；否则最近 2 周均值 > 前 3 周均值 × 1.25 为 `up`，< × 0.8 为 `down`，其余 `flat`。
  - `canonicalUrl(url: string): string`（小写 host 去 `www.`＋path 去末尾 `/`，丢 query 和 hash）
  - `findingKey(productId: Id, headline: string, urls: string[]): string`（标题去空白和标点、小写＋排序后的规范 URL）
  - `isDuplicate(c: { productId: Id; headline: string; urls: string[] }, recent: { productId: Id; dedupeKey: string; urls: string[] }[]): boolean`（同产品下 key 相同，或共享任一规范 URL）

- [ ] **Step 1: 写失败的测试**（要点）
```ts
it('puts major before notable and verified before unconfirmed', () => {})
it('folds minor findings and names quiet products', () => {})
it('uses the no-news gist when nothing happened', () =>
  expect(composeBrief({ ...base, findings: [], gist: NO_NEWS_GIST }).findingIds).toEqual([]))
it('never includes withdrawn, pending or unproven findings', () => {})
it('records the inserted range of an edit and none for a first version', () => {
  const v1 = applyCardEdit(null, edit('甲乙'), now); expect(v1.addedSpans).toEqual([])
  const v2 = applyCardEdit(v1, edit('甲新乙'), now); expect(v2.version).toBe(2); expect(v2.addedSpans).toEqual([{ start: 1, end: 2 }])
})
it('hides heat bars with fewer than 5 dated articles', () => {})
it('treats a shared article URL as the same finding', () =>
  expect(isDuplicate({ productId: 'p', headline: '完全不同的标题', urls: ['https://www.a.com/x/?utm=1'] }, [{ productId: 'p', dedupeKey: 'k', urls: ['https://a.com/x'] }])).toBe(true))
```
- [ ] **Step 2: Run** `pnpm vitest run tests/core` → FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4: Run** `pnpm vitest run tests/core` → PASS
- [ ] **Step 5: Commit** `feat(core): 哨报编排、档案版本、热度与去重`

---

### Task 5: SQLite 存储

**Files:**
- Create: `src/store/db.ts`、`src/store/migrations.ts`、`src/store/repo.ts`
- Test: `tests/store/repo.spec.ts`

**Interfaces:**
- Consumes: Task 2 的类型。
- Produces:
  - `openDb(path: string): Db`；`interface Db { atomic<T>(fn: () => T): T; prepare(sql: string): StatementSync; close(): void }`。用 `node:sqlite` 的 `DatabaseSync`，WAL、`synchronous=FULL`、文件权限 600、目录 700；`atomic` 用嵌套 SAVEPOINT（照 superagent `src/app/store.ts:139-153`）；`migrations.ts` 导出 `MIGRATIONS: string[]`，按 `PRAGMA user_version` 逐个执行。目录锁照 superagent 用 `proper-lockfile` 的 `lockSync(dataDir)`。
  - 表：`tracks`、`products`、`track_products`、`candidates`、`sources`、`findings`、`card_versions`（主键 product_id+dimension+version）、`card_edits`、`facts`（主键 product_id+version）、`briefs`（主键 date）、`runs`、`settings_kv`。数组和对象字段存 JSON 文本。
  - `class Repo`（构造参数 `Db`），方法：
    - 赛道：`createTrack(t: Omit<Track,'id'|'createdAt'>): Track`、`updateTrack(id, patch: Partial<Pick<Track,'name'|'brief'|'dimensions'|'status'>>): Track`、`listTracks(): Track[]`、`productsOfTrack(trackId): Product[]`、`dimensionsOfProduct(productId): Dimension[]`（所属各赛道维度并集，按首次出现顺序）
    - 产品与候选：`upsertProduct(p: Omit<Product,'id'|'createdAt'> & { id?: Id }): Product`（同名同公司视为同一产品）、`setProductStatus(id, s)`、`linkProduct(trackId, productId)`、`addCandidate(c: Omit<Candidate,'id'>): Candidate`、`listCandidates(trackId, batchId?): Candidate[]`、`latestBatchId(trackId): Id|null`
    - 来源与发现：`addSource(s: Omit<Source,'id'>): Source`、`updateSource(id, patch: Partial<Pick<Source,'openedVia'|'quoteFound'|'supportsClaim'|'syndicationGroup'>>)`、`getSources(ids): Source[]`、`addFinding(f: Omit<Finding,'id'|'createdAt'>): Finding`、`updateFinding(id, patch: Partial<Pick<Finding,'status'|'statusNote'|'unconfirmedUntil'|'read'|'late'>>)`、`findingsOfDate(date): Finding[]`、`findingsOfProduct(productId, sinceDays?: number): Finding[]`、`openUnconfirmed(productId): Finding[]`
    - 档案：`latestCards(productId): CardVersion[]`、`cardHistory(productId, dimension): CardVersion[]`、`addCardVersion(v: CardVersion)`、`addCardEdit(e: Omit<CardEdit,'id'|'status'>): CardEdit`、`pendingCardEdits(productId): CardEdit[]`、`setCardEditStatus(id, s)`、`latestFacts(productId): Facts|null`、`addFacts(f: Omit<Facts,'version'|'createdAt'>): Facts`
    - 哨报与运行：`getBrief(date): Brief|null`、`putBrief(b: Brief)`、`createRun(r: Pick<Run,'kind'|'date'|'trackId'|'productId'>): Run`、`updateRun(id, patch: Partial<Run>)`、`listRuns(sinceDate): Run[]`、`runsOfDate(date, kind?): Run[]`、`spentOn(date, productId?): number`
    - 设置：`getSetting<T>(key): T|undefined`、`setSetting(key, value)`（存 `lastCompletedDailyDate` 等）

- [ ] **Step 1: 写失败的测试**：建赛道→加产品→多赛道并集维度；同名同公司 `upsertProduct` 返回同一 id；卡片版本追加且 `latestCards` 只给最新版；`atomic` 里抛错整体回滚；迁移在已有库上重复打开不报错；`spentOn` 汇总当天花费。
- [ ] **Step 2: Run** `pnpm vitest run tests/store` → FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4: Run** 同上 → PASS
- [ ] **Step 5: Commit** `feat(store): SQLite 存储与仓储`

---

### Task 6: 前哨工具（Agent 交作业）

**Files:**
- Create: `src/host/ports.ts`、`src/host/tools.ts`
- Test: `tests/host/tools.spec.ts`

**Interfaces:**
- Consumes: `Repo`（Task 5）、`isDuplicate`/`findingKey`/`canonicalUrl`（Task 4）、`weeklyHeat`（Task 4）。
- Produces:
  - `src/host/ports.ts`：
```ts
export interface ToolSpec<S extends z.ZodType = z.ZodType> { name: string; description: string; schema: S; execute(args: z.infer<S>): Promise<unknown> }
export interface SessionSpec { sessionId: string; title: string; prompt: string; tools: ToolSpec[]; model: { provider: string; model: string } | null }
export interface SessionOutcome { reason: 'completed'|'aborted'|'error'|'max-tokens'|'interrupted'|'blocked'|'timeout'; usage: Usage; error?: string }
export interface SessionDriver {
  run(spec: SessionSpec, signal: AbortSignal): Promise<SessionOutcome>   // 一轮：建或续会话、挂工具、发消息、等这轮结束
  nudge(sessionId: string, text: string, signal: AbortSignal): Promise<SessionOutcome>   // 同一会话再发一句、再等一轮
  startInteractive(spec: Omit<SessionSpec,'model'>): Promise<void>      // 追问：建会话、发消息、不等
  archive(sessionId: string): Promise<void>
}
export interface ModelClient { complete(req: { system: string; user: string }, signal: AbortSignal): Promise<{ text: string; usage: Usage }> }
export interface Clock { now(): Date; at(when: Date, fn: () => void): () => void }
export interface IconFetcher { fetch(productId: Id, candidates: string[]): Promise<string|null> }   // 返回本地文件路径
```
  - `src/host/tools.ts`：`export function researchTools(kind: 'recommend'|'baseline'|'daily'|'verify'|'followup', scope: ToolScope): ToolSpec[]`，`interface ToolScope { repo: Repo; runId: Id; trackId: Id|null; productId: Id|null; now: () => Date; icons: IconFetcher; onDone(summary: string): void }`。各类型拿到的工具：
    - recommend：`outpost_submit_candidate`、`outpost_done`
    - baseline：`outpost_read`、`outpost_submit_card`、`outpost_submit_facts`、`outpost_done`
    - daily：`outpost_read`、`outpost_submit_finding`、`outpost_propose_card_edit`、`outpost_submit_facts`、`outpost_done`
    - verify：`outpost_read_pending`、`outpost_report_check`、`outpost_add_source`、`outpost_done`
    - followup：`outpost_read`
  - 参数（zod，长度是硬上限，超了返回可读错误让 Agent 改）：
    - `SourceInput = { url: string.url(), title ≤80, publisher ≤30, publishedAt?: string, kind: SourceKind, isOfficial: boolean, quote: 1–200 字，原文逐字 }`
    - `outpost_submit_candidate { name ≤30, company ≤30, region, form ≤20, oneLiner ≤40, tier, reason ≤60, officialUrl?, iconUrl?, articles: {url,title,publishedAt?}[] ≥1 }` → 写产品（`status: 'candidate'`）、候选（`heat = weeklyHeat(articles 的日期)`、`selected = tier === 'strong'`），异步取图标；返回 `{ candidateId }`
    - `outpost_submit_card { dimension（必须属于该产品维度）, summary ≤30, bullets 1–3 条每条 ≤40, body ≤1500（用 [n] 引第 n 个来源）, sources: SourceInput[] ≥1, inferenceQuotes: string[]（body 里必须逐字存在） }` → 写来源和一条 `CardEdit`（建档时也走待核查）
    - `outpost_submit_facts { form, platforms, price, firstReleased, rivals: string[] ≤5 }`
    - `outpost_submit_finding { headline ≤30, why ≤80, importance, claimKind, dimensions: DimensionKey[], inference: boolean, sources: SourceInput[] ≥1 }` → 重复（`isDuplicate` 对近 14 天）返回 `{ error: '这条和已有发现重复：<标题>' }`；否则写来源和 `status: 'pending'` 的发现，返回 `{ findingId }`
    - `outpost_propose_card_edit { dimension, summary, bullets, body, sources, inferenceQuotes, changeNote ≤30, findingIds: Id[] ≥1（必须是本次运行提交的） }`
    - `outpost_read {}` → `{ product, dimensions, facts, cards: { dimension, summary, bullets }[], recentFindings: { headline, status, createdAt }[]（14 天）, knownUrls: string[] }`
    - `outpost_read_pending {}` → 本产品 `pending` 发现、`pending` 卡片修改、`unconfirmed` 发现，各带 `itemId`、`claimKind`、要核的话、来源 `{ sourceId, url, quote }`
    - `outpost_report_check { sourceId, openedVia, quoteFound: boolean|null, supportsClaim: boolean|null, syndicationGroup?: string（如原始通稿 URL） }`
    - `outpost_add_source { itemId, source: SourceInput }`（补找到的佐证，每个 itemId 最多 3 次）
    - `outpost_done { summary ≤100 }` → 调 `scope.onDone`

- [ ] **Step 1: 写失败的测试**
```ts
it('rejects an over-long headline with a readable message', async () => {
  const r = await call('outpost_submit_finding', { ...finding, headline: '长'.repeat(31) })
  expect(r).toMatchObject({ error: expect.stringContaining('headline') })
})
it('rejects a duplicate finding', async () => {
  await call('outpost_submit_finding', finding)
  expect(await call('outpost_submit_finding', { ...finding, headline: '别的说法' })).toMatchObject({ error: expect.stringContaining('重复') })
})
it('rejects an inference quote that is not in the body', async () => {})
it('rejects a card for a dimension the product does not have', async () => {})
it('pre-selects strong candidates and computes heat', async () => {})
it('limits outpost_add_source to 3 per item', async () => {})
it('gives each run kind exactly its tools', () =>
  expect(researchTools('verify', scope).map(t => t.name)).toEqual(['outpost_read_pending','outpost_report_check','outpost_add_source','outpost_done']))
```
- [ ] **Step 2: Run** `pnpm vitest run tests/host/tools.spec.ts` → FAIL
- [ ] **Step 3: 实现**（工具 execute 里 zod 解析失败要捕获并返回 `{ error }`，不抛出）
- [ ] **Step 4: Run** 同上 → PASS
- [ ] **Step 5: Commit** `feat(host): 前哨研究工具`

---

### Task 7: dsh 适配器（会话驱动与直接调模型）

**Files:**
- Create: `src/host/dsh-sessions.ts`、`src/host/dsh-model.ts`
- Test: `tests/host/dsh-sessions.spec.ts`、`tests/host/dsh-model.spec.ts`、`tests/fixtures/dsh-context.ts`

**Interfaces:**
- Consumes: `ports.ts`（Task 6）。
- Produces: `class DshSessionDriver implements SessionDriver`（构造：`ctx: Context, workspaceDir: string`），`class DshModelClient implements ModelClient`（构造：`ctx: Context, pick: () => { provider: string; model: string } | null`）。
- 做法（dsh 0.2.3-alpha.2 已核实的接口）：
  - 建会话：`ctx.workspaceRegistry.create(workspaceDir, '前哨')` → `ctx.sessionController.create({ sessionId, workspaceId, agentPreset: 'outpost-researcher' })` → `ctx.sessionController.rename({ sessionId, title })`；已存在时 `resolveAgent(sessionId)` 直接拿 agent（照 superagent `src/app/sessions.ts:138-154`）。
  - 挂工具：在 `ctx.on('agent/created', …)` 里，只对 id 以 `outpost-` 开头、且登记过工具的会话，用 `agent.ctx.tools.register({ name, description, parameters: z.toJSONSchema(schema), output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] }, execute: (args, exec) => spec.execute(args) })`（照 superagent `sessions.ts:206-215`）；已存在的 agent 也立即挂一次。
  - 选模型：`spec.model` 非空时 `agent.model.select(spec.model)`；**不要**用已废弃的 `agent/request` 事件。
  - 发消息：`agent.followup({ id: MessageId('outpost:<uuid>'), role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-outpost', form: 'relay' } })`，并对 `@deepseek-ai/dsh-llm` 的 `MessageSourceMap` 做模块扩充（照 superagent `src/app/delivery.ts:8-12, 66-84`），随后 `ctx.sessionPersistence.flush()`。
  - 等这一轮结束：监听 `ctx.on('session/event', (session, event) => …)`，累加 `event.type === 'assistant/message'` 的 `event.data.usage`（`inputTokens` 减去 `cacheReadTokens` 记作未命中输入），收到 `turn/end` 时用其 `reason` 结束；`signal` 超时（30 分钟由调用方给）→ `ctx.sessionController.cancel(...)` 并返回 `reason: 'timeout'`。
  - 归档：`ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })`。
  - 直接调模型：`ctx.llm.stream({ provider, model, system, messages: [{ role: 'user', content: [{ type: 'text', text: user }] }] })`，用 `BlockAssembler` 收集，取文本块拼接，`usage` 从 assembler 读；`pick()` 为 null 时用 `ctx.agentDefaultModel.currentSelection()`。

- [ ] **Step 1: 写 `tests/fixtures/dsh-context.ts`**：照 superagent `tests/fixtures/host.ts:135-258`，用 `new Context()` + `ctx.reflect.provide` 提供假的 `sessionController`、`workspaceRegistry`、`sessionPersistence`、`llm`、`agentDefaultModel`；假 agent 有自己的 `agent.ctx`（带假 `tools`），能手动发出 `agent/created`、`session/event`（`assistant/message`、`turn/end`）。
- [ ] **Step 2: 写失败的测试**
```ts
it('creates a session with the outpost-researcher preset and renames it', async () => {})
it('registers the spec tools only on its own session', async () => {})
it('resolves with summed usage when the turn ends', async () => {
  const p = driver.run(spec, signal); emitAssistant({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 40 }); emitTurnEnd('completed')
  expect(await p).toEqual({ reason: 'completed', usage: { inputTokens: 60, outputTokens: 20, cacheReadTokens: 40 } })
})
it('cancels and reports timeout when the signal aborts', async () => {})
it('uses the default model when none is configured', async () => {})
```
- [ ] **Step 3: Run** `pnpm vitest run tests/host/dsh-*.spec.ts` → FAIL
- [ ] **Step 4: 实现**
- [ ] **Step 5: Run** 同上 → PASS
- [ ] **Step 6: 真机冒烟**：在开发版 dsh（Task 1 Step 7 的命令）里，临时在 `apply` 末尾跑一次 `driver.run`，给一个只有 `outpost_done` 的会话、提示「调用 outpost_done，summary 写 ok」。
Expected: 会话列表里出现「前哨」工作区下的这个会话，日志打印 `completed` 和非零 usage。确认后删掉临时代码。
- [ ] **Step 7: Commit** `feat(host): dsh 会话驱动与模型调用适配器`

---

### Task 8: 运行器、推荐、建档

**Files:**
- Create: `src/host/jobs/runner.ts`、`src/host/jobs/recommend.ts`、`src/host/jobs/baseline.ts`、`src/host/icons.ts`、`src/host/prompts.ts`、`prompts/recommend.md`、`prompts/baseline.md`
- Test: `tests/host/runner.spec.ts`、`tests/host/recommend.spec.ts`、`tests/host/baseline.spec.ts`、`tests/fixtures/fake-driver.ts`

**Interfaces:**
- Consumes: `Repo`、`researchTools`、`SessionDriver`、`canSpend`/`costOf`、`localDate`。
- Produces:
  - `prompts.ts`：`renderPrompt(name: 'recommend'|'baseline'|'daily'|'verify'|'synthesize'|'followup', vars: Record<string,string>): string`（读包内 `prompts/<name>.md`，替换 `{{var}}`，缺变量抛错）。
  - `class JobRunner`，构造 `{ repo: Repo; driver: SessionDriver; clock: Clock; settings: () => RuntimeSettings }`，`interface RuntimeSettings { maxParallel: number; dailyBudgetYuan: number; sessionTimeoutMin: number; prices: PriceTable; model: { provider: string; model: string } | null }`：
    - `session(kind: RunKind, scope: { trackId?: Id; productId?: Id }, build: (runId: Id) => { title: string; prompt: string; tools: (onDone: (s: string) => void) => ToolSpec[] }): Promise<Run>`：建 `Run` → `canSpend` 不过则 `status: 'skipped'`、`error` 写原因并返回 → 拿并发名额（`maxParallel`）→ `driver.run`；临时错误（`reason: 'error'` 且错误匹配网络、限流、5xx，照 superagent `transient()`）重试 3 次、间隔 15 秒；一轮结束还没 `outpost_done` → `driver.nudge(sessionId, '请继续完成任务；全部提交后调用 outpost_done。')` 一次；记 usage、`costYuan`、状态。会话 id ＝ `outpost-<kind>-<runId 前 8 位>`。
    - `archiveOld(now: Date): Promise<void>`：归档 7 天前结束的会话。
  - `icons.ts`：`class NodeIconFetcher implements IconFetcher`，依次试 `iconUrl`、官网 `/favicon.ico`、`/apple-touch-icon.png`，用 Node `fetch`，只收 `image/*`、≤256 KiB，存 `<dataDir>/icons/<productId>.<ext>`，失败返回 null。
  - `recommend.ts`：`startRecommendation(deps, trackId: Id, refine?: string): Promise<Id /* batchId */>`：新 batchId，后台起一个 `recommend` 会话（提示带赛道名、关注点、维度、`refine`、上一批候选名单与档次），不等它结束就返回。
  - `baseline.ts`：`startBaseline(deps, productIds: Id[]): void`：每个产品置 `baselining`，各起一个 `baseline` 会话；结束后调 `verifyProduct(productId, 'baseline')`（Task 9，先以接口注入），完成后置 `tracking`。
  - `prompts/recommend.md`、`prompts/baseline.md`：中文，写清任务、只能通过工具提交、每条结论带原文引句、AI 自己的判断写进 `inferenceQuotes`、只说有来源的话、提交完调 `outpost_done`。推荐提示要求：强烈推荐 4–8 个，可以考虑 ≤6 个，没推荐的要写原因；热度用找到的报道链接，不要编数字。

- [ ] **Step 1: 写 `tests/fixtures/fake-driver.ts`**：按脚本回放工具调用（`script: Record<sessionIdPrefix, (tools) => Promise<SessionOutcome>>`），记录每次 `run`/`nudge`/`archive`。
- [ ] **Step 2: 写失败的测试**
```ts
it('skips with a reason when the daily budget is spent', async () => {
  repo.updateRun(seedRun.id, { costYuan: 20 })
  const run = await runner.session('daily', { productId: 'p1' }, build)
  expect(run).toMatchObject({ status: 'skipped', error: '今日总预算已用完' })
})
it('never runs more than maxParallel sessions at once', async () => {})
it('retries a transient error 3 times then fails', async () => {})
it('nudges once when the agent ends without outpost_done', async () => {})
it('records cost from usage and prices', async () => {})
it('streams candidates into the batch as the agent submits them', async () => {})
it('passes the refine text and previous candidates into the prompt', async () => {})
it('moves a product to tracking after its baseline is verified', async () => {})
it('isolates a failed product from the others', async () => {})
```
- [ ] **Step 3: Run** `pnpm vitest run tests/host/runner.spec.ts tests/host/recommend.spec.ts tests/host/baseline.spec.ts` → FAIL
- [ ] **Step 4: 实现**
- [ ] **Step 5: Run** 同上 → PASS
- [ ] **Step 6: Commit** `feat(host): 运行器、推荐与建档`

---

### Task 9: 核查、日更、合并

**Files:**
- Create: `src/host/jobs/verify.ts`、`src/host/jobs/daily.ts`、`prompts/verify.md`、`prompts/daily.md`
- Test: `tests/host/verify.spec.ts`、`tests/host/daily.spec.ts`

**Interfaces:**
- Consumes: `JobRunner`、`judge`、`applyCardEdit`、`Repo`。
- Produces:
  - `verifyProduct(deps, productId: Id, scope: 'baseline'|'daily'): Promise<void>`：起 `verify` 会话（提示说明：先 `ctx.web.fetch` 等价的 `web_fetch` 打开；打不开或拿到验证页 / 登录页再用浏览器工具（若可用）；都不行看搜索摘要；只差一个第三方佐证时最多 3 次搜索、3 个网页去找；逐条 `outpost_report_check`）。会话结束后由代码（不是 Agent）对每条 `pending` 和 `unconfirmed` 发现调 `judge` 并写回状态。合并规则：
    - 日更的 `CardEdit`：其 `findingIds` 全部 `verified` → `applyCardEdit` 写新版本、置 `applied`；任一 `withdrawn`/`unproven` → `rejected`；否则保持 `pending`。
    - 建档的 `CardEdit`：把作废来源从 `sourceIds` 去掉，正文里对应 `[n]` 删除并重新编号；至少剩一个有效来源 → 写第 1 版；否则 `rejected`，该维度显示「暂无可核实的信息」。
    - 超过 7 天仍不够格的发现由 `judge` 判成 `unproven`。
  - `runDailyProduct(deps, productId: Id, date: string): Promise<Run>`：起 `daily` 会话（提示带 `outpost_read` 说明、只找上次运行以来的新东西、没有就直接 `outpost_done('无新动态')`），然后 `verifyProduct(productId, 'daily')`。

- [ ] **Step 1: 写失败的测试**
```ts
it('marks a 公众号 finding 原文打不开 and keeps it out of the dossier', async () => {
  script.verify = reportCheck({ openedVia: 'unopened', quoteFound: null })
  await verifyProduct(deps, 'p1', 'daily')
  expect(repo.findingsOfProduct('p1')[0]).toMatchObject({ status: 'unconfirmed', statusNote: '原文打不开' })
  expect(repo.pendingCardEdits('p1')).toHaveLength(1)
})
it('applies a card edit once all its findings are verified', async () => {})
it('promotes an unconfirmed finding when a second source is added later', async () => {})
it('expires an unconfirmed finding to unproven after 7 days', async () => {})
it('strips a withdrawn source and renumbers citations in a baseline card', async () => {
  expect(renumbered('甲[1]乙[2]丙[3]', removed: [2])).toBe('甲[1]乙丙[2]')
})
it('rejects a baseline card with no valid source', async () => {})
it('runs verify after the daily session', async () => {})
```
- [ ] **Step 2: Run** `pnpm vitest run tests/host/verify.spec.ts tests/host/daily.spec.ts` → FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4: Run** 同上 → PASS
- [ ] **Step 5: Commit** `feat(host): 核查、日更与档案合并`

---

### Task 10: 汇总、调度、追问

**Files:**
- Create: `src/host/jobs/synthesize.ts`、`src/host/scheduler.ts`、`src/host/followup.ts`、`prompts/synthesize.md`、`prompts/followup.md`
- Test: `tests/host/synthesize.spec.ts`、`tests/host/scheduler.spec.ts`、`tests/host/daily-flow.spec.ts`、`tests/host/followup.spec.ts`

**Interfaces:**
- Consumes: `composeBrief`、`NO_NEWS_GIST`、`ModelClient`、`runDailyProduct`、`nextRunAt`/`shouldCatchUp`/`cutoffAt`。
- Produces:
  - `synthesizeBrief(deps, date: string): Promise<Brief>`：当天 `verified`+`unconfirmed` 的 `major`/`notable` 为空 → gist 用 `NO_NEWS_GIST`，不调模型；否则 `ModelClient.complete`（`prompts/synthesize.md`：一句话 ≤60 字、只依据给出的发现、不加新事实）。`skipped` 来自当天 `status: 'skipped'` 的日更运行（「因预算未跑：<产品>」）。花费计入 `synthesize` 运行。
  - `appendLate(deps, date: string, productId: Id): Promise<Brief>`：截止后才完成的产品，其当天发现置 `late: true`，重新 `composeBrief`（保留 gist，若原来是 `NO_NEWS_GIST` 且现在有内容则重新生成）。
  - `class Scheduler`，构造 `{ clock; repo; settings; runDailyProduct; synthesize; appendLate; archiveOld }`：
    - `start()`：若 `shouldCatchUp(now, runTime, repo.getSetting('lastCompletedDailyDate'))` → 立即 `runDay(today)`；并按 `nextRunAt` 定时。
    - `runDay(date)`：要跑的产品＝跟踪中、且当天没有 `done`/`skipped` 日更运行的（实现「只补没跑完的」）；全部完成或到 `cutoffAt(start)` 时 `synthesize(date)`；截止后完成的走 `appendLate`；全部结束写 `lastCompletedDailyDate`；最后 `archiveOld`。
    - `runProductNow(productId)`：「立即更新」，跑完后 `appendLate`（若今天已有哨报）或 `synthesize`。
    - `stop()`：取消定时器。
  - `startFollowup(deps, findingId: Id): Promise<{ sessionId: string }>`：`driver.startInteractive`，会话 id `outpost-followup-<8 位>`，标题「追问 · <产品> <标题>」，首条消息用 `prompts/followup.md` 填入这条发现（标题、为什么、来源）和该产品各维度卡片的 summary＋bullets；工具只给 `outpost_read`。

- [ ] **Step 1: 写失败的测试**
```ts
it('catches up once after a missed run', async () => {
  clock.set('2026-11-25T14:00'); repo.setSetting('lastCompletedDailyDate', '2026-11-24'); scheduler.start()
  await flush(); expect(calls.runDailyProduct).toHaveLength(trackedCount); expect(repo.getBrief('2026-11-25')).not.toBeNull()
  scheduler.start(); await flush(); expect(calls.runDailyProduct).toHaveLength(trackedCount)
})
it('resumes only unfinished products', async () => {
  repo.createRun({ kind: 'daily', date: '2026-11-25', productId: 'p1', trackId: null }); repo.updateRun(lastRunId, { status: 'done' })
  clock.set('2026-11-25T14:00'); scheduler.start(); await flush()
  expect(calls.runDailyProduct.map(c => c.productId)).toEqual(['p2', 'p3'])
})
it('synthesizes at the 2-hour cutoff and appends late products marked 迟到', async () => {})
it('uses the no-news gist without calling the model when nothing happened', async () => {})
it('names budget-skipped products in the brief', async () => {   // daily-flow.spec.ts
  settings.dailyBudgetYuan = 0.01; await scheduler.runDay('2026-11-25')
  const brief = repo.getBrief('2026-11-25')!
  expect(brief.skipped.map(s => s.reason)).toEqual(['今日总预算已用完', '今日总预算已用完'])
  expect(calls.runDailyProduct).toHaveLength(1)
})
it('opens a followup session titled 追问 · <产品> <标题> with only outpost_read', async () => {})
```
- [ ] **Step 2: Run** `pnpm vitest run tests/host/synthesize.spec.ts tests/host/scheduler.spec.ts tests/host/daily-flow.spec.ts tests/host/followup.spec.ts` → FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4: Run** 同上 → PASS
- [ ] **Step 5: Commit** `feat(host): 哨报汇总、定时补跑与追问`

---

### Task 11: 后台接口与组装

**Files:**
- Create: `src/host/api.ts`、`src/host/runtime.ts`
- Modify: `src/index.ts`、`src/host/http.ts`
- Test: `tests/host/api.spec.ts`、`tests/host/runtime.spec.ts`

**Interfaces:**
- Consumes: 前面所有 host 模块。
- Produces：
  - `runtime.ts`：`class Runtime`（构造 `ctx, config`）：建 `dataDir` 和锁、`openDb`、`Repo`、两个适配器、`JobRunner`、`Scheduler`；`start()` 注册路由并启动调度；`stop()` 停调度、关库、释放锁。`index.ts` 的 `apply` 改为 `new Runtime(ctx, config)`，`ctx.effect` 里返回 `stop`。`browserAvailable` ＝ `ctx.get('browserUse') !== undefined`。
  - `api.ts`：`createApi(rt: Runtime): (route: string, req: ApiRequestParts) => Promise<unknown>`，路由表（同时导出类型 `Api`，前端 `import type` 用）：

| 路由 | 请求 | 响应 |
|---|---|---|
| `GET state` | — | `{ tracks: { track: Track; products: { product: Product; hasNew: boolean; progress: Run['progress'] }[]; candidatesToReview: number }[]; todayDate: string; todayUnread: number; todayCostYuan: number; browserAvailable: boolean }` |
| `GET brief` | `query.date?` | `{ brief: Brief|null; findings: Finding[]; products: Product[]; sources: Source[]; prevDate: string|null }` |
| `POST findings/:id/read` | — | `{ ok: true }` |
| `POST brief/read-all` | `body.date` | `{ ok: true }` |
| `POST tracks` | `{ name ≤20, brief ≤100, extraDimensions: string[] }` | `{ trackId, batchId }`（维度＝默认 6 个＋自定义，同时开始推荐） |
| `PATCH tracks/:id` | `{ name?, brief?, extraDimensions? }` | `Track` |
| `POST tracks/:id/recommend` | `{ refine? ≤60 }` | `{ batchId }` |
| `GET tracks/:id/candidates` | — | `{ batchId; running: boolean; elapsedSec: number; candidates: (Candidate & { product: Product })[] }` |
| `POST tracks/:id/start` | `{ candidateIds: Id[] ≥1 }` | `{ ok: true }`（赛道 `active`、产品入赛道、开始建档） |
| `GET products/:id` | — | `{ product; facts: Facts|null; cards: CardVersion[]; history: Record<DimensionKey, { version: number; changeNote: string; createdAt: string }[]>; sources: Source[]; dimensions: Dimension[]; progress: Run['progress'] }` |
| `GET products/:id/findings` | — | `{ findings: Finding[]; sources: Source[] }` |
| `PATCH products/:id` | `{ status?: 'tracking'|'paused'; dailyBudgetYuan?: number|null }` | `Product` |
| `POST products/:id/update-now` | — | `{ runId }` |
| `GET icons/:productId` | — | 图片字节（正确的 `content-type`，404 时前端用统一色块） |
| `POST followup` | `{ findingId }` | `{ sessionId }` |
| `GET runs` | `query.days? = 7` | `{ runs: (Run & { productName: string|null })[] }` |
| `POST runs/:id/retry` | — | `{ runId }` |

- [ ] **Step 1: 写失败的测试**：用真 `Repo`（临时目录）＋假驱动，逐个路由打一遍，校验请求参数（超长 400）、`POST tracks` 同时生成 batch、`GET state` 的 `todayUnread` 与 `unreadCount` 一致、`GET icons` 无图标时 404；`runtime.spec.ts` 测 `apply` 后路由已注册、`effect` 清理后锁释放（可以再次打开）。
- [ ] **Step 2: Run** `pnpm vitest run tests/host/api.spec.ts tests/host/runtime.spec.ts` → FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4: Run** `pnpm check` → PASS
- [ ] **Step 5: Commit** `feat(host): 后台接口与运行时组装`

---

### Task 12: 前端外壳（两栏、中栏、图标、样式）

**Files:**
- Create: `src/client/api.ts`、`src/client/shell/App.tsx`、`src/client/shell/MiddleColumn.tsx`、`src/client/shell/route.ts`、`src/client/ui/ProductIcon.tsx`、`src/client/ui/Tag.tsx`、`src/client/ui/SourceChip.tsx`、`src/client/ui/Citation.tsx`
- Modify: `src/client/index.tsx`、`src/client/styles.css`、`src/client/locales.ts`
- Test: `tests/client/shell.spec.tsx`、`tests/client/ui.spec.tsx`、`tests/fixtures/client.tsx`

**Interfaces:**
- Consumes: `import type { Api } from '../host/api.ts'`。
- Produces：
  - `api.ts`：`call<K extends keyof Api>(route: K, req?)`（照 superagent `src/client/api.ts` 的 `caller`，fetch `/outpost/api/...`）；`usePoll<T>(load, deps, intervalMs = 5000)`（照 superagent；有运行进行中时调用方传 2000）。
  - `route.ts`：`type Route = { page: 'today'; date?: string } | { page: 'newTrack'; trackId?: Id } | { page: 'product'; productId: Id; tab: 'dossier'|'feed'|'sources'; expand?: DimensionKey } | { page: 'runs' } | { page: 'settings' }`；`useRoute(): [Route, (r: Route) => void]`（内存状态，最后一次存 `localStorage`，读写包 try/catch）。
  - `MiddleColumn`：结构和文案按设计文档 §5.1 与 `docs/mockups/1-导航.html` 方案 B：顶「前哨」＋「＋ 新赛道」；「今日哨报」右侧「n 条新」；每赛道可折叠分组（标题＋产品数），组内各产品（`ProductIcon`＋名称，有新发现蓝点，建档中显示「建档中」），`picking` 的赛道下是「挑产品 · 已选 n」，有待看候选显示「候选推荐 · n 条待看」；底部固定「运行记录」（右侧「今天 ¥x」）和「设置」。**M1 不显示「赛道概览 · 对比矩阵」**（那是 M2）。
  - `ProductIcon({ product, size })`：有 `iconPath` → `<img src="/outpost/api/icons/<id>">`，加载失败回退；否则统一色块：`--dsw-alias-state-business-tertiary` 底、`--dsw-alias-link` 色、名称首字符。
  - `Tag({ kind })`，kind 与文案：`official 官方`、`inference 推论`、`ai AI 归纳`、`fresh 今天改过`、`unconfirmed 待确认`、`unopened 原文打不开`、`late 迟到`、`major 重要`、`notable 值得留意`。
  - `Citation({ n, source })`：上标 `[n]`，悬停浮层显示标题、发布方、日期、原文引句，点击新窗口打开 URL。
  - `index.tsx` 的 `trailing` 注入未读数：一个每 60 秒轮询 `GET state` 的 `todayUnread` 可观察值（照 forge 示例的 `hooks.count`）。

- [ ] **Step 1: 写 `tests/fixtures/client.tsx`**（假 ctx、`stubApi(routes)` 用 `vi.stubGlobal('fetch')`、`mount`、`click`、`text`）。
- [ ] **Step 2: 写失败的测试**
```ts
it('lists tracks with their products and a blue dot for new findings', async () => {})
it('does not show 赛道概览 · 对比矩阵 in M1', async () => { expect(text()).not.toContain('对比矩阵') })
it('shows a uniform tile when a product has no icon', async () => {})
it('falls back to the tile when the icon fails to load', async () => {})
it('shows the source quote on citation hover', async () => {})
it('restores the last route and survives a throwing localStorage', async () => {})
```
- [ ] **Step 3: Run** `pnpm vitest run tests/client/shell.spec.tsx tests/client/ui.spec.tsx` → FAIL
- [ ] **Step 4: 实现**（样式按 Global Constraints；对照 `docs/mockups/1-导航.html` 方案 B 的间距：中栏约 244px、行高 34px、圆角 8px）
- [ ] **Step 5: Run** 同上 → PASS
- [ ] **Step 6: Commit** `feat(client): 两栏外壳、中栏与通用组件`

---

### Task 13: 今日哨报页

**Files:**
- Create: `src/client/pages/Today.tsx`、`src/client/navigation.ts`
- Test: `tests/client/today.spec.tsx`

**Interfaces:**
- Consumes: `GET brief`、`POST findings/:id/read`、`POST brief/read-all`、`POST followup`；`ctx.uiWorkspace.openSession`（经 superagent `openKnownSession` 的写法，复制到 `src/client/navigation.ts`）。
- 页面按设计文档 §5.2 与 `docs/mockups/2-今日哨报.html` 方案 A：日期标题（「11月25日 · 周二」格式）、元信息行、「‹ 昨天」、「全部已读」、浅蓝 gist 块、赛道筛选胶囊、卡片流（产品、赛道、重要程度 Tag、标题、「为什么值得注意：」、来源胶囊（官方来源带「官方」）、「改了档案：<维度>」、「看改动 →」「追问」；待确认的加「待确认」及 note）、小更新折叠行「另有 n 条小更新，点开看」、末行「今天没动静：」＋图标名称；`skipped` 显示「因预算未跑：…」；没有任何发现时只显示「今天没有值得看的变化」。卡片滚出视野（`IntersectionObserver`，进入过视野后离开）即调 `read`，变淡。
- 「看改动 →」跳 `{ page: 'product', productId, tab: 'dossier', expand: 第一个受影响维度 }`。

- [ ] **Step 1: 写失败的测试**
```ts
it('orders cards as the brief says and folds minor updates', async () => {})
it('shows only 今天没有值得看的变化 on a no-news day', async () => {
  stubApi({ 'GET brief': { brief: { ...empty, gist: '今天没有值得看的变化' }, findings: [], products, sources: [], prevDate: null } })
  await mount(<Today />); expect(text()).toContain('今天没有值得看的变化'); expect(all('.op-card')).toHaveLength(0)
})
it('marks a card read after it leaves the viewport', async () => {})
it('labels an unopenable source 原文打不开', async () => {})
it('opens a followup session in the workspace', async () => {})
it('jumps to the changed dimension on 看改动', async () => {})
it('names budget-skipped products', async () => {})
```
- [ ] **Step 2: Run** `pnpm vitest run tests/client/today.spec.tsx` → FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4: Run** 同上 → PASS
- [ ] **Step 5: Commit** `feat(client): 今日哨报页`

---

### Task 14: 新建赛道页

**Files:**
- Create: `src/client/pages/NewTrack.tsx`
- Test: `tests/client/new-track.spec.tsx`

**Interfaces:**
- Consumes: `POST tracks`、`PATCH tracks/:id`、`POST tracks/:id/recommend`、`GET tracks/:id/candidates`（运行中每 2 秒轮询）、`POST tracks/:id/start`。
- 页面按设计文档 §5.3 与 `docs/mockups/3-新建赛道.html` 方案 B：三步指示；第 1 步表单（赛道名、一句话关注点、默认 6 个维度标签＋「＋ 维度」）提交后折叠为摘要块（右侧「改」）；状态行「找到 n 个候选，按热度和贴合度排好 · 用时 m 分 s 秒」（运行中显示「正在找…已找到 n 个」）；一句话调整输入框（回车＝`recommend`）；分组「强烈推荐」（「全选这一组」）、「可以考虑」（紧凑卡片）、「没推荐的 n 个」（折叠，展开看原因）；候选卡片网格 `repeat(auto-fill, minmax(270px, 1fr))`，内容：图标、名称、公司 · 国内/海外 · 形态、一句话、热度（`showBars` 时迷你柱状图＋「找到 n 篇相关报道 · 热度上升/平稳/回落」，否则只写「找到 n 篇相关报道」）、「为什么推荐：」；选中＝蓝色描边＋右上蓝勾；吸底栏「已选 n 个 · 预计每天 ¥x～y（估算）· 首次建档约 n 分钟，建好后明早出第一份哨报」＋「稍后再挑」＋「开始跟踪 n 个」。估算：有最近 7 天日更花费时按每产品日均 × n 的 ±30%，否则用每产品 ¥0.5～1.0 并标「估算」。开始后跳到第一个产品页。

- [ ] **Step 1: 写失败的测试**
```ts
it('shows candidates as they arrive while the recommendation runs', async () => {})
it('pre-selects strong candidates and updates the footer count', async () => {})
it('sends the refine text and shows the new batch', async () => {})
it('writes 找到 n 篇 without bars when fewer than 5 articles are dated', async () => {})
it('starts tracking the selected candidates', async () => {})
it('lets you leave and come back to a running recommendation', async () => {})
```
- [ ] **Step 2: Run** `pnpm vitest run tests/client/new-track.spec.tsx` → FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4: Run** 同上 → PASS
- [ ] **Step 5: Commit** `feat(client): 新建赛道与挑产品`

---

### Task 15: 产品档案页

**Files:**
- Create: `src/client/pages/Product.tsx`、`src/client/pages/product/DossierTab.tsx`、`src/client/pages/product/FeedTab.tsx`、`src/client/pages/product/SourcesTab.tsx`
- Test: `tests/client/product.spec.tsx`

**Interfaces:**
- Consumes: `GET products/:id`、`GET products/:id/findings`、`PATCH products/:id`、`POST products/:id/update-now`、`POST followup`。
- 页面按设计文档 §5.4 与 `docs/mockups/4-产品档案.html` 方案 A：对象头（大图标、名称、状态胶囊、「公司 · 建档日期 · 最近更新」、「全部展开」「⋯」（暂停跟踪 / 恢复、每日预算）「立即更新」）；页签「档案｜动态（n）｜来源 n」（M1 没有「专题」页签）；档案页：关键事实条（形态、平台、价格、首发、对标）、一句话定位（取 `positioning` 卡的 summary）、维度卡片网格 `repeat(auto-fill, minmax(300px, 1fr))`（维度名、`isFresh` 时「今天改过」、bullets、「n 个来源」、「展开」）；展开后卡片 `grid-column: 1 / -1`，左右 2:1：左边正文（`[n]` 渲染成 `Citation`；`addedSpans` 在 `isFresh` 时浅蓝底；`inferenceSpans` 后挂「推论」）与来源胶囊，右边「这一节怎么变过来的」时间线（最新实心点），「收起 ↑」。被拒绝或空的维度显示「暂无可核实的信息」。建档中显示每个维度的占位和进度。`route.expand` 指定的卡片初始展开并滚到可见。动态页签：该产品全部发现（含待确认、未证实的收起项），样式同哨报卡片。来源页签：来源列表（标题、发布方、日期、类型、「官方」、被几条结论引用）。

- [ ] **Step 1: 写失败的测试**
```ts
it('expands the routed dimension and shows its history', async () => {})
it('highlights added text only within 72 hours', async () => {})
it('tags inference spans 推论', async () => {})
it('expand-all opens every card', async () => {})
it('shows 暂无可核实的信息 for a rejected dimension', async () => {})
it('shows progress while the product is being baselined', async () => {})
it('update-now starts a run and shows it is running', async () => {})
```
- [ ] **Step 2: Run** `pnpm vitest run tests/client/product.spec.tsx` → FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4: Run** 同上 → PASS
- [ ] **Step 5: Commit** `feat(client): 产品档案页`

---

### Task 16: 运行记录与设置页

**Files:**
- Create: `src/client/pages/Runs.tsx`、`src/client/pages/Settings.tsx`
- Test: `tests/client/runs.spec.tsx`、`tests/client/settings.spec.tsx`

**Interfaces:**
- Consumes: `GET runs`、`POST runs/:id/retry`、`GET state`（`browserAvailable`）、插件配置表单（`ctx.get('configForms')?.get('dsh-outpost')`，照 superagent `src/client/deployment.tsx` 的 `usePageForm` 与 `PluginConfig`；同一个表单组件也注册在 `plugins.row.config`）。
- 运行记录（设计文档 §5.7）：按天分组；每行：类型（推荐 / 建档 / 日更 / 核查 / 汇总 / 追问）、对象、状态、用时、花费（估算）；点一行用 `openKnownSession` 打开会话；失败的显示原因和「重试」；跳过的显示原因。
- 设置：配置表单（每天几点跑、同时跑几个、每日总预算、单会话超时、模型、价格表）；数据目录只读显示；「浏览器兜底」状态：`browserAvailable` 为 false 时提示「没开浏览器兜底：公众号、小红书、知乎等页面打不开，相关消息会一直是『待确认』。到『插件』页启用 dsh-browser-use 和 Playwright 浏览器两项后重启。」

- [ ] **Step 1: 写失败的测试**
```ts
it('opens the run session when a row is clicked', async () => {})
it('retries a failed run', async () => {})
it('explains how to enable the browser fallback when it is off', async () => {
  stubApi({ 'GET state': { ...state, browserAvailable: false } }); await mount(<Settings />)
  expect(text()).toContain('没开浏览器兜底')
})
it('shows no browser notice when it is on', async () => {})
```
- [ ] **Step 2: Run** `pnpm vitest run tests/client/runs.spec.tsx tests/client/settings.spec.tsx` → FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4: Run** `pnpm check` → PASS
- [ ] **Step 5: Commit** `feat(client): 运行记录与设置页`

---

### Task 17: 装进桌面版并真实验收

**Files:**
- Modify: `dev/README.md`、`docs/设计文档.md`（只改实际与文档不符之处）
- Create: `docs/acceptance/m1.md`（验收记录，截图放 `docs/acceptance/m1/`）

- [ ] **Step 1: 打包**
Run: `pnpm check && pnpm pack`
Expected: 生成 `dsh-outpost-<version>.tgz`

- [ ] **Step 2: 装进桌面版**（先确认桌面版空闲、正常退出；装前备份 `~/.dsh/profiles/desktop/package.json` 与 `cordis.patch.yml` 到 `~/Projects/AgentOutpost-data/backup/`）
Run: `"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add /Users/tiger/Projects/AgentOutpost/dsh-outpost-<version>.tgz`，再在 `~/.dsh/profiles/desktop/cordis.patch.yml` 给 `outpost` 行（包自带补丁插入的行 id 是 `outpost`，`dsh-outpost` 是包名）加 `config: { dataDir: /Users/tiger/Projects/AgentOutpost-data }`，打开桌面版。完整步骤见 `dev/README.md`「装进桌面版」。
Expected: `dsh plugin --profile desktop list` 列出 `dsh-outpost`；侧栏出现「前哨」；`incompatible-version` 不出现。

- [ ] **Step 2b: 开启浏览器兜底**：在「插件」页启用 `dsh-browser-use` 和 Playwright 两行，重启；设置页不再显示提示。

- [ ] **Step 3: 真实跑一遍**（真搜索、真模型）：建「Personal Agent」赛道 → 推荐出现候选（含国内产品）→ 选 3 个开始跟踪 → 建档完成 → 在设置里把运行时间设为 2 分钟后 → 出今日哨报 → 点「看改动 →」「追问」→ 运行记录可打开会话。
Expected（写进 `docs/acceptance/m1.md`）：每步实际结果、总花费、出错和处理；至少 1 条公众号来源被浏览器打开核实，或说明为什么没有。

- [ ] **Step 4: 截图核对界面**：1440 和 1920 宽各截今日哨报、新建赛道、产品档案（展开一张卡）、运行记录、设置；逐项对照草图和 Global Constraints（字色近黑、正文 ≥15px、无左侧竖条、内容铺满、深色模式切一次）。
Expected: 截图存 `docs/acceptance/m1/`，不符项已修或记在验收记录里。

- [ ] **Step 5: Commit 并打 tag**
`git add -A && git commit -m "chore: M1 验收" && git tag m1`
