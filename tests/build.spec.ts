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
