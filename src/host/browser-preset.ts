/**
 * The research preset with the browser fallback (`outpost-researcher`), registered by Outpost itself (M2.4) instead of
 * shipped as a row of cordis.patch.yml: only when the two browser packages are installed in the profile. Shipped as a row,
 * it showed as 「加载失败」 among DSH's presets after a plain `dsh plugin add` of Outpost, whose profile lacks them; research
 * then runs on `outpost-researcher-basic` (the patch file's row), as it did when this one failed to load.
 *
 * It is the basic preset with the `browser` group: a page plain fetching cannot read (WeChat articles, Xiaohongshu,
 * Zhihu) is opened in a headless Chrome. Only research sessions get it, never a session of the user's own; the
 * browser-use service is isolated to the group, as DSH requires of a service inside a preset. What it costs:
 * - Every research session gets the `mcp__playwright-mcp__*` tools, and they run without approval while the session reads
 *   pages nobody vetted. Outpost refuses it `browser_run_code_unsafe` (arbitrary JavaScript in the Playwright process, by
 *   Playwright's own description) with a guard on the session's agent; opening, reading and clicking through pages stay.
 * - Every live research session runs a Playwright MCP server (about 125 MB), and one that opened a page a headless Chrome
 *   (0.7 GB on a blank page, more on real ones). Outpost ends a research session's live agent when its run is over, which
 *   closes both.
 * A Playwright provider turned on for the whole profile clashes with this one ("serverName "playwright-mcp" is already in
 * use"); research then runs on the basic preset (src/host/dsh-sessions.ts `chooseResearchPreset`).
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Settings key: `true` when the user turned the browser fallback off on 设置 (M2.4); it is on unless they did. */
export const BROWSER_OFF = 'browserFallbackOff'

/** The packages the `browser` group needs (`dsh plugin add` them; install.sh does). */
export const BROWSER_PACKAGES = ['@deepseek-ai/dsh-browser-use', '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'] as const
/** Where the Desktop's Chrome is on a Mac; elsewhere Playwright looks for one itself. */
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/**
 * Whether every browser package is installed where DSH loads the profile's plugins from: a `node_modules` above the
 * profile (`baseUrl`, the context's, where DSH resolves a preset's plugins), or above Outpost's own files (a profile that
 * holds Outpost as a package of its own), as Node would look for it. A development or linked Outpost lives elsewhere: the
 * profile's own directory is what counts then.
 */
export function browserPackagesInstalled(baseUrl?: unknown, start = dirname(fileURLToPath(import.meta.url))): boolean {
  const starts = [start]
  try { if (baseUrl !== undefined && baseUrl !== null) starts.unshift(fileURLToPath(new URL(String(baseUrl)))) } catch { /* not a file: address */ }
  const under = (from: string, name: string) => {
    for (let dir = from; ; dir = dirname(dir)) {
      if (existsSync(join(dir, 'node_modules', name, 'package.json'))) return true
      if (dirname(dir) === dir) return false
    }
  }
  return BROWSER_PACKAGES.every(name => starts.some(from => under(from, name)))
}

/** The basic preset's plugin rows (cordis.patch.yml `outpost-researcher-basic-preset`), which this one repeats. */
const RESEARCH_PLUGINS = [
  { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'You are a product research analyst powered by the {{model}} model.' } },
  { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
  { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
]
const COMPACTION = {
  id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true, toolResultPruner: true },
  config: [
    { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
    { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
    { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } },
  ],
}

/** The definition handed to DSH's preset registry (`agentPresets.register`), as the row `@deepseek-ai/dsh-agent-preset` would. */
export function browserPresetDefinition(chrome: string | null = existsSync(MAC_CHROME) ? MAC_CHROME : null) {
  return {
    id: 'outpost-researcher',
    name: '前哨调研员',
    description: '前哨的调研会话专用，不供手动选择。只能联网搜索和读网页，没有命令行和文件工具。',
    order: 92,
    plugins: [
      ...RESEARCH_PLUGINS,
      {
        id: 'browser', name: 'cordis:group', group: true, isolate: { browserUse: true },
        config: [
          { id: 'browser-use', name: '@deepseek-ai/dsh-browser-use' },
          { id: 'browser-use-playwright', name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp', config: { mode: 'launch', headless: true, ...chrome ? { executablePath: chrome } : {} } },
        ],
      },
      COMPACTION,
    ],
  }
}
