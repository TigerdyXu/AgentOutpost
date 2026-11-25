/**
 * The research agents' instructions: Markdown files in the package's `prompts/` directory with `{{name}}` slots. They are
 * read on every use, so editing one needs no restart.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type PromptName = 'recommend' | 'baseline' | 'daily' | 'verify' | 'synthesize' | 'followup'

const PACKAGE_NAME = 'dsh-outpost'
const SLOT = /\{\{\s*([A-Za-z_]\w*)\s*\}\}/g

let root: string | undefined

/**
 * The directory of this package: the nearest one above this module whose `package.json` is named `dsh-outpost`. The same
 * search works from the sources (`src/host/`) and from the bundle (`lib/`).
 * @throws When there is no such directory.
 */
export function packageRoot(): string {
  if (root !== undefined) return root
  const start = dirname(fileURLToPath(import.meta.url))
  for (let dir = start; ; dir = dirname(dir)) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest) && nameOf(manifest) === PACKAGE_NAME) return root = dir
    if (dirname(dir) === dir) throw new Error(`${PACKAGE_NAME}: no package.json named "${PACKAGE_NAME}" above ${start}`)
  }
}

function nameOf(manifest: string): unknown {
  try { return (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name } catch { return undefined }
}

/**
 * `prompts/<name>.md` with each `{{var}}` replaced by `vars[var]`. Values go in as they are: braces inside a value are
 * not expanded again.
 * @throws When the template names a variable `vars` does not give.
 */
export function renderPrompt(name: PromptName, vars: Record<string, string>): string {
  const template = readFileSync(join(packageRoot(), 'prompts', `${name}.md`), 'utf8')
  return template.replace(SLOT, (_slot, key: string) => {
    const value = Object.hasOwn(vars, key) ? vars[key] : undefined
    if (value === undefined) throw new Error(`prompts/${name}.md needs the variable "${key}"`)
    return value
  })
}
