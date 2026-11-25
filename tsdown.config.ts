import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
// `?raw` imports a file as its text, as Vite and vitest do; tsdown refuses `.css` ids without @tsdown/css, so this loads them.
const raw = { name: 'raw',
  resolveId: (source: string, importer?: string) => source.endsWith('?raw') && importer ? resolve(dirname(importer), source) : undefined,
  load: (id: string) => id.endsWith('?raw') ? { code: `export default ${JSON.stringify(readFileSync(id.slice(0, -4), 'utf8'))}`, moduleType: 'js' as const }
    : undefined }
export default defineConfig([
  // Host half: an ESM Cordis plugin; dsh packages and runtime dependencies resolve at load time.
  { entry: { index: 'src/index.ts' }, outDir: 'lib', format: 'esm', fixedExtension: false, platform: 'node', target: 'es2024', dts: true, clean: true,
    deps: { neverBundle: [/^@deepseek-ai\//, 'zod', 'diff', 'proper-lockfile'] } },
  // Client half: one CommonJS factory handed to the dsh module loader. It may `require` only modules of the dsh client
  // platform table (packages/client/web/src/platform.ts), and has no dynamic `import()`. `minify: false` keeps the wrapper
  // text verbatim; the default dead-code pass reprints the whole chunk, banner included.
  { entry: { client: 'src/client/index.tsx' }, outDir: 'lib', format: 'cjs', platform: 'browser', dts: false, clean: false, plugins: [raw], minify: false, checks: { legacyCjs: false },
    deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'zod'] },
    outputOptions: { entryFileNames: 'client.js', banner: 'window.__ModuleLoader__.load({ id: "dsh-outpost", factory: (require) => {', footer: 'return module.exports; } });', intro: 'var module = { exports: {} }; var exports = module.exports;' } },
])
