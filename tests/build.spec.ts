import { browserPresetDefinition } from '../src/host/browser-preset.ts'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

// Reads the artifacts of `pnpm build`; `pnpm check` builds before it tests.
it('wraps lib/client.js in the dsh module loader', () => {
  const text = readFileSync('lib/client.js', 'utf8')
  expect(text.startsWith('window.__ModuleLoader__.load({ id: "dsh-outpost", factory: (require) => {')).toBe(true)
  expect(text).toContain('var module = { exports: {} }; var exports = module.exports;')
  expect(text.trimEnd().endsWith('return module.exports; } });')).toBe(true)
  expect(text).not.toMatch(/require\.async|import\(/)
  // The factory may require only modules of the dsh client platform table that the plugin leaves unbundled.
  const required = new Set([...text.matchAll(/\brequire\(["']([^"']+)["']\)/g)].map(match => match[1]))
  expect([...required].every(name => ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'zod'].includes(name!))).toBe(true)
  // JSX goes through the platform's React runtime rather than a bundled copy of React.
  expect(required.has('react/jsx-runtime')).toBe(true)
  expect(text).not.toContain('__SECRET_INTERNALS')
})

it('builds the host entry as an ES module with its declarations', () => {
  const text = readFileSync('lib/index.js', 'utf8')
  expect(text).toMatch(/export \{[^}]*\bapply\b[^}]*\}/)
  expect(text).not.toContain('window.__ModuleLoader__')
  expect(readFileSync('lib/index.d.ts', 'utf8')).toContain('OutpostConfig')
})

// cordis.patch.yml ships in the package; dev/overlay.cordis.yml repeats its rows for a development run.
const PATCH_FILES = ['cordis.patch.yml', 'dev/overlay.cordis.yml']
/** The row `id` of a patch file's insert list, without comment lines. */
function rowOf(file: string, id: string): string {
  const lines = readFileSync(file, 'utf8').split('\n').filter(line => !line.trimStart().startsWith('#'))
  const start = lines.indexOf(`    - id: ${id}`)
  expect(start, `${file}: ${id}`).toBeGreaterThan(-1)
  const end = lines.findIndex((line, i) => i > start && /^ {4}- /.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n').replace(/\n+$/, '') // the file's last row ends with it
}
/** The `plugins` list of a preset row, as text. */
const pluginsOf = (row: string) => row.slice(row.indexOf('        plugins:\n'))
/** `plugins` text without the plugin entry `id` and everything under it. */
function withoutPlugin(plugins: string, id: string): string {
  const lines = plugins.split('\n')
  const start = lines.indexOf(`          - id: ${id}`)
  expect(start, id).toBeGreaterThan(-1)
  const end = lines.findIndex((line, i) => i > start && /^ {10}- /.test(line))
  lines.splice(start, (end === -1 ? lines.length : end) - start)
  return lines.join('\n')
}

it('repeats the research preset row, unchanged, in the development overlay, and ships no browser preset row', () => {
  expect(rowOf('dev/overlay.cordis.yml', 'outpost-researcher-basic-preset')).toBe(rowOf('cordis.patch.yml', 'outpost-researcher-basic-preset'))
  for (const file of PATCH_FILES) {
    const text = readFileSync(file, 'utf8')
    // M2.4: the browser one is registered by Outpost when its packages are installed (src/host/browser-preset.ts).
    expect(text, file).not.toMatch(/^ {4}- id: outpost-researcher-preset/m)
    // No browser for the whole profile either: every session of the user's own would get one.
    expect(text, file).not.toMatch(/^ {4}- id: outpost-browser-use/m)
  }
})

it('keeps the browser fallback inside the research preset Outpost registers, launching the local Chrome without a window', () => {
  const browser = browserPresetDefinition('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  expect(browser).toMatchObject({ id: 'outpost-researcher', name: '前哨调研员', order: 92 })
  // The browser-use service and its provider in a group of their own, the service isolated to it (a preset's service
  // must be, or DSH refuses the preset); nothing in it is off.
  expect(browser.plugins.find(plugin => plugin.id === 'browser')).toEqual({
    id: 'browser', name: 'cordis:group', group: true, isolate: { browserUse: true },
    config: [
      { id: 'browser-use', name: '@deepseek-ai/dsh-browser-use' },
      { id: 'browser-use-playwright', name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp', config: { mode: 'launch', headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } },
    ],
  })
  expect(JSON.stringify(browser)).not.toMatch(/disabled/)
  // Without Chrome where the Mac keeps it, Playwright looks for a browser itself.
  expect(JSON.stringify(browserPresetDefinition(null))).not.toMatch(/executablePath/)
})

/** A preset's plugins as `key=value` lines (and bare `key` for an object or list), depth first, quotes left out. */
function flatYaml(plugins: string): string[] {
  return plugins.split('\n').slice(1).filter(line => line.trim()).map(line => {
    const [key, ...rest] = line.trim().replace(/^- /, '').split(': ')
    const value = rest.join(': ').replace(/^'(.*)'$/, '$1')
    return value ? `${key}=${value}` : key!.replace(/:$/, '')
  })
}
function flatObject(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(flatObject)
  return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) => v !== null && typeof v === 'object' ? [key, ...flatObject(v)] : [`${key}=${String(v)}`])
}

// M1.4: research runs on this one when the browser preset is not there (its packages are not installed, as after a plain
// `dsh plugin add` of Outpost) or clashes with a Playwright browser of the whole profile (src/host/dsh-sessions.ts).
it('ships a research preset without the browser that is otherwise the browser preset', () => {
  const basic = rowOf('cordis.patch.yml', 'outpost-researcher-basic-preset')
  expect(basic).toContain([
    '    - id: outpost-researcher-basic-preset',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: outpost-researcher-basic',
    '        name: 前哨调研员（无浏览器）',
  ].join('\n'))
  // It shows in the user's preset list (a preset row cannot hide itself), right after the browser one, saying whom it is for.
  expect(basic).toContain('        order: 93\n')
  expect(basic).toMatch(/^ {8}description: 前哨的调研会话专用.*不供手动选择/m)
  // No browser of its own: neither the group nor either package, so it loads in a profile that has neither.
  expect(basic).not.toMatch(/- id: browser|dsh-browser-use|playwright/)
  expect(basic).not.toMatch(/disabled:/)
  // Everything else as the browser preset has it: the persona, the web tools, compaction.
  const browser = browserPresetDefinition(null)
  expect(flatYaml(pluginsOf(basic))).toEqual(flatObject(browser.plugins.filter(plugin => plugin.id !== 'browser')))
})
