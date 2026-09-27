/**
 * The Model Capability settings store: the browser-side controller over the
 * plugin's own same-origin JSON routes (`{prefix}/view`, `{prefix}/apply`).
 *
 * Reads travel the view route (settings + llm seams on the Host); writes
 * travel the apply route with optimistic-revision conflict handling. The
 * section keeps an immutable draft per provider card and only sends the
 * fields the user actually changed (`KEEP`/`REVERT` sentinels for untouched
 * vs. reset).
 * @module dsh-model-capability-enhancement/client/store
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Route prefix of this plugin's Host JSON routes. */
export const DEFAULT_ROUTE_PREFIX = '/dsh-model-capability-enhancement'

/** One model's user-configurable capability fields (view shape). */
export interface ModelCapabilityFields {
  input?: string[] | null
  reasoningEfforts?: Record<string, string | null> | false | null
}

/** One model row in the view. */
export interface ModelCapabilityView {
  id: string
  name: string
  modalities: string[] | null
  reasoning: {
    efforts: { id: string; name: string | null }[]
    defaultEffort: string | null
  } | null
  user: ModelCapabilityFields | null
  editable: boolean
  reason: 'basePinned' | 'notInUserList' | null
}

/** One provider card in the view. */
export interface ProviderCapabilityView {
  id: string
  displayName: string
  declared: boolean
  configured: boolean
  perModel: 'models' | 'modelOverrides' | null
  listError: string | null
  defaultReasoning: string | null
  defaultInput: { available: boolean; current: string[] | null }
  models: ModelCapabilityView[]
}

/** The complete snapshot the section renders. */
export interface CapabilitySnapshot {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
  writable: boolean
  revision: number
  levels: readonly string[]
  providers: readonly ProviderCapabilityView[]
  saving: boolean
  saved?: boolean
  saveError?: string
}

/** One apply outcome from the Host. */
interface ApplyResponse {
  ok?: boolean
  code?: string
  message?: string
}

/** Owns the plugin-route transport for the Model Capability section. */
export class CapabilityStore {
  readonly store: SnapshotStore<CapabilitySnapshot>

  constructor(private readonly prefix: string = DEFAULT_ROUTE_PREFIX) {
    this.store = createSnapshotStore<CapabilitySnapshot>({
      status: 'idle',
      writable: false,
      revision: 0,
      levels: [],
      providers: [],
      saving: false,
    })
  }

  /** Refresh the capability view. A failure keeps the last good snapshot. */
  async load(): Promise<void> {
    this.store.update(draft => {
      if (draft.status === 'idle') draft.status = 'loading'
    })
    try {
      const response = await fetch(`${this.prefix}/view`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = (await response.json()) as {
        ok?: boolean
        writable?: boolean
        revision?: number
        levels?: readonly string[]
        providers?: readonly ProviderCapabilityView[]
        message?: string
      }
      if (body.ok !== true) throw new Error(body.message ?? 'view failed')
      this.store.update(draft => {
        draft.status = 'ready'
        draft.error = undefined
        draft.writable = body.writable === true
        draft.revision = typeof body.revision === 'number' ? body.revision : 0
        draft.levels = body.levels ?? []
        draft.providers = body.providers ?? []
      })
    } catch (error) {
      this.store.update(draft => {
        draft.status = 'error'
        draft.error = error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * Persist one provider's edits through the apply route with the last known
   * revision. A `conflict` surfaces as a save error the section shows; every
   * other refusal message is shown verbatim.
   * @param payload - provider id, changed defaults and changed model drafts.
   * @returns true when the write landed.
   */
  async apply(payload: Record<string, unknown>): Promise<boolean> {
    this.store.update(draft => {
      draft.saving = true
      draft.saved = false
      draft.saveError = undefined
    })
    try {
      const response = await fetch(`${this.prefix}/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = (await response.json()) as ApplyResponse
      if (body.ok !== true) {
        this.store.update(draft => {
          draft.saving = false
          draft.saveError = body.code === 'conflict' ? 'settings-conflict' : body.message ?? 'apply failed'
        })
        return false
      }
      this.store.update(draft => {
        draft.saving = false
        draft.saved = true
      })
      await this.load()
      return true
    } catch (error) {
      this.store.update(draft => {
        draft.saving = false
        draft.saveError = error instanceof Error ? error.message : String(error)
      })
      return false
    }
  }
}
