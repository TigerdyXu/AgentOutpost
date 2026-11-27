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

it('repeats both research preset rows, unchanged, in the development overlay', () => {
  for (const id of ['outpost-researcher-preset', 'outpost-researcher-basic-preset'])
    expect(rowOf('dev/overlay.cordis.yml', id), id).toBe(rowOf('cordis.patch.yml', id))
})

it('keeps the browser fallback inside the research preset, on, in both patch files', () => {
  const shipped = rowOf('cordis.patch.yml', 'outpost-researcher-preset')
  // The browser-use service and its provider in a group of their own, the service isolated to it (a preset's service
  // must be, or DSH refuses the preset), launching the local Chrome without a window; nothing in the row is off.
  expect(shipped).toContain([
    '          - id: browser',
    '            name: cordis:group',
    '            group: true',
    '            isolate:',
    '              browserUse: true',
    '            config:',
    "              - id: browser-use",
    "                name: '@deepseek-ai/dsh-browser-use'",
    "              - id: browser-use-playwright",
    "                name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'",
    '                config:',
    '                  mode: launch',
    '                  headless: true',
    '                  executablePath: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].join('\n'))
  expect(shipped).not.toMatch(/disabled:/)
  // No browser for the whole profile any more: every session of the user's own would get one.
  for (const file of PATCH_FILES) {
    expect(readFileSync(file, 'utf8')).not.toMatch(/^ {4}- id: outpost-browser-use/m)
  }
})

// M1.4: research runs on this one when the browser preset does not load (its packages are not installed, as after a plain
// `dsh plugin add` of Outpost) or clashes with a Playwright browser of the whole profile (src/host/dsh-sessions.ts).
it('ships a research preset without the browser that is otherwise the browser preset', () => {
  const browser = rowOf('cordis.patch.yml', 'outpost-researcher-preset')
  const basic = rowOf('cordis.patch.yml', 'outpost-researcher-basic-preset')
  expect(basic).toContain([
    '    - id: outpost-researcher-basic-preset',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: outpost-researcher-basic',
    '        name: 前哨调研员（无浏览器）',
  ].join('\n'))
  // It shows in the user's preset list (a preset row cannot hide itself), right after the browser one, saying whom it is for.
  expect(browser).toContain('        order: 92\n')
  expect(basic).toContain('        order: 93\n')
  expect(basic).toMatch(/^ {8}description: 前哨的调研会话专用.*不供手动选择/m)
  // No browser of its own: neither the group nor either package, so it loads in a profile that has neither.
  expect(basic).not.toMatch(/- id: browser|dsh-browser-use|playwright/)
  expect(basic).not.toMatch(/disabled:/)
  // Everything else as the browser preset has it: the persona, the web tools, compaction.
  expect(pluginsOf(basic)).toBe(withoutPlugin(pluginsOf(browser), 'browser'))
})
