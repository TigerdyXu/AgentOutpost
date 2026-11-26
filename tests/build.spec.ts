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
it('keeps the browser fallback inside the research preset, on, in both patch files', () => {
  /** The `outpost-researcher-preset` row of a patch file, without comment lines. */
  const presetRow = (file: string) => {
    const lines = readFileSync(file, 'utf8').split('\n').filter(line => !line.trimStart().startsWith('#'))
    const start = lines.indexOf('    - id: outpost-researcher-preset')
    expect(start).toBeGreaterThan(-1)
    const end = lines.findIndex((line, i) => i > start && /^ {4}- /.test(line))
    return lines.slice(start, end === -1 ? undefined : end).join('\n')
  }
  const shipped = presetRow('cordis.patch.yml')
  expect(presetRow('dev/overlay.cordis.yml')).toBe(shipped)
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
  for (const file of ['cordis.patch.yml', 'dev/overlay.cordis.yml']) {
    expect(readFileSync(file, 'utf8')).not.toMatch(/^ {4}- id: outpost-browser-use/m)
  }
})
