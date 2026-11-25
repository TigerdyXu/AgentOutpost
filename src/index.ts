/** Host half of 前哨 (Outpost): a Cordis plugin serving the panel's API under `/outpost/api/`. */
import type { Context } from '@deepseek-ai/cordis'
import { Config, type OutpostConfig } from './config.ts'
import { ApiError, registerRoutes } from './host/http.ts'

export const name = 'dsh-outpost'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'tools', 'systemPrompt', 'webServer', 'llm', 'web', 'agentDefaultModel']
export { Config }
export type { OutpostConfig }

/**
 * Mount the plugin. This skeleton answers only the health check; the route is removed when the plugin unloads.
 * @param ctx - the plugin's Context.
 * @param _config - the `outpost` entry's configuration.
 */
export async function apply(ctx: Context, _config: OutpostConfig): Promise<void> {
  ctx.effect(() => registerRoutes(ctx, async route => {
    if (route === 'GET health') return { ok: true }
    throw new ApiError(404, 'Unknown operation')
  }), 'dsh-outpost: routes')
}
