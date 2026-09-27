/**
 * dsh-model-capability-enhancement Host plugin entry.
 *
 * Mounts the Settings → 模型能力 JSON routes on the GUI webserver. The plugin
 * carries no composition config: everything it edits lives in the llm-pi-ai
 * settings namespace.
 * @module dsh-model-capability-enhancement
 */

import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_ROUTE_PREFIX, mountCapabilityUi } from './routes.ts'

export const name = 'dsh-model-capability-enhancement'

/** Optional webserver: headless spines (ACP, worker) skip the routes. */
export const inject = ['webServer'] as const

export { SETTINGS_NS, THINKING_LEVELS, KEEP, REVERT } from './routes.ts'
export type {
  CapabilityApplyResult,
  CapabilityViewResult,
  ModelCapabilityFields,
  ModelCapabilityView,
  ModelDraft,
  ProviderCapabilityView,
  ApplyPayload,
} from './routes.ts'

export function apply(ctx: Context): void {
  const routePrefix = DEFAULT_ROUTE_PREFIX
  ctx.effect(() => mountCapabilityUi(ctx, routePrefix), 'dsh-model-capability-enhancement: routes')
}
