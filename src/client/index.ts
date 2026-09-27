/**
 * dsh-model-capability-enhancement browser half: the Model Capability
 * settings section.
 *
 * Registers ONE entry into the `settings.section` list slot (declared by
 * ui-settings, composed by the settings shell): per-model vision input,
 * provider default reasoning level, and per-model reasoning effort wire maps
 * for hand-declared llm-pi-ai providers. All reads and writes travel the
 * plugin's own `{prefix}/view` and `{prefix}/apply` Host routes.
 * @module dsh-model-capability-enhancement/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: ctx.locale merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings.section SlotMap merge (ui-settings declares it).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the theme service merge (ctx.theme + theme/change event).
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { ModelCapabilitySection, type ModelCapabilityInjected } from './ModelCapabilitySection.tsx'
import { CapabilityStore } from './store.ts'
import { en, zh, type ModelCapabilityKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.model-capability'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale']

/**
 * Register the Model Capability section once the `settings.section`
 * declaration is on the ledger. The section loads its snapshot lazily on
 * first render; the injected `colorScheme` rides the theme service so the
 * Ant Design palette follows the active light/dark theme.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-model-capability-enhancement: copy dictionaries')

  const controller = new CapabilityStore()
  // Theme observation: expose a snapshot/subscribe pair so the section's
  // ConfigProvider can switch between Ant Design light/dark algorithms.
  const theme = ctx.get('theme')
  let colorScheme: 'light' | 'dark' = theme?.getTheme().active.colorScheme ?? 'light'
  const themeListeners = new Set<() => void>()
  const notifyTheme = (snapshot: ThemeSnapshot): void => {
    colorScheme = snapshot.active.colorScheme
    for (const listener of [...themeListeners]) {
      try { listener() } catch { /* one bad subscriber must not strand the rest */ }
    }
  }
  if (theme !== undefined) {
    ctx.effect(() => ctx.on('theme/change', notifyTheme), 'dsh-model-capability-enhancement: theme sync')
  }

  // Registration-time text (the nav label thunk) and the inject face share
  // one bound translate; copy freshness rides the locale revision.
  const t = ctx.locale.bind(NS) as (key: ModelCapabilityKey) => string
  const injected = (): ModelCapabilityInjected => ({
    controller,
    t,
    colorScheme: {
      getSnapshot: () => colorScheme,
      subscribe: (fn: () => void) => {
        themeListeners.add(fn)
        return () => { themeListeners.delete(fn) }
      },
    },
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'model-capability',
    order: 20,
    label: () => t('nav'),
    inject: injected,
  }, ModelCapabilitySection))
}
