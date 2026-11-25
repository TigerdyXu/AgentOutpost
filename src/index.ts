/** Host half of 前哨 (Outpost): a Cordis plugin serving the panel's API under `/outpost/api/`. */
import type { Context } from '@deepseek-ai/cordis'
import { Config, type OutpostConfig } from './config.ts'
import { Runtime } from './host/runtime.ts'

export const name = 'dsh-outpost'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'tools', 'systemPrompt', 'webServer', 'llm', 'web', 'agentDefaultModel']
export { Config }
export type { OutpostConfig }

/**
 * Mount the plugin: take the data directory, serve the API and start the daily schedule. Unloading the plugin stops it all
 * and releases the directory.
 * @param ctx - the plugin's Context.
 * @param config - the `outpost` entry's configuration.
 * @throws When the data directory cannot be taken (another Outpost holds it: 「数据目录被另一个前哨进程占用：…」).
 */
export async function apply(ctx: Context, config: OutpostConfig): Promise<void> {
  ctx.effect(() => {
    const runtime = new Runtime(ctx, config)
    try {
      runtime.start()
    } catch (error) {
      void runtime.stop().catch(stopped => { ctx.logger.error('dsh-outpost: could not stop after a failed start: %s', String(stopped)) })
      throw error
    }
    return () => runtime.stop()
  }, 'dsh-outpost: runtime')
}
