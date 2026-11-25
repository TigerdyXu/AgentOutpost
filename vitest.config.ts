import { defineConfig } from 'vitest/config'
// Share one React instance across DSH client packages and tests. `css.include` keeps the text of the stylesheet that the
// client imports with `?raw` (vitest empties CSS files by default).
export default defineConfig({ resolve: { dedupe: ['react', 'react-dom'] }, test: { include: ['tests/**/*.spec.{ts,tsx}'], css: { include: [/\.css(\?|$)/] } } })
