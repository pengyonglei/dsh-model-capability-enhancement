/**
 * dsh-model-capability-enhancement Host half.
 *
 * Exposes two same-origin JSON routes to the Settings �?模型能力 section:
 *
 * - `GET  {prefix}/view`  �?the editable model-capability view for every
 *   hand-declared llm-pi-ai provider (per-model `input`, provider `reasoning`,
 *   per-model `reasoningEfforts`), read through the settings and llm seams.
 * - `POST {prefix}/apply` �?persist one set of edits through the settings
 *   seam with optimistic-revision conflict handling. Fields the section did
 *   not touch travel as `KEEP`; a user reset travels as `REVERT` (unset).
 *
 * The namespace is deliberately NOT exposed through the standard settings
 * RPCs: this section is the single write path for the three capability
 * fields the Models page omits.
 * @module dsh-model-capability-enhancement
 */

import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { LlmConfigurableProvider, LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'

/** The llm-pi-ai settings namespace this plugin edits. */
export const SETTINGS_NS = 'llm-pi-ai'

/** Route prefix of the Host JSON routes (mirrors the bundle id). */
export const DEFAULT_ROUTE_PREFIX = '/dsh-model-capability-enhancement'

/** The seven reasoning effort levels the pi-ai profile schema accepts. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** Wire sentinels: a field the section did not touch vs. one it reset. */
export const KEEP = 'KEEP'
export const REVERT = 'REVERT'

/** One model's user-configurable capability fields (write shape). */
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

/** The whole view answer. */
export interface CapabilityViewResult {
  ok: true
  ns: string
  writable: boolean
  revision: number
  levels: readonly string[]
  providers: ProviderCapabilityView[]
}

/** One apply outcome. */
export type CapabilityApplyResult =
  | { ok: true; revision: number | null; noop: boolean }
  | { ok: false; code: string; message: string }

/** One draft edit for a model. */
export interface ModelDraft {
  id: string
  input?: string[] | typeof KEEP | typeof REVERT
  reasoningEfforts?: Record<string, string | null> | false | typeof KEEP | typeof REVERT
}

/** The apply payload (client �?host). */
export interface ApplyPayload {
  provider: string
  defaultReasoning?: string | typeof KEEP | typeof REVERT
  defaultInput?: string[] | typeof KEEP | typeof REVERT
  models?: ModelDraft[]
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fail(code: string, message: string): CapabilityApplyResult {
  return { ok: false, code, message }
}

function validInput(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((m) => m === 'text' || m === 'image')
}

function validEfforts(value: unknown): value is Record<string, string | null> | false {
  if (value === false) return true
  if (!isPlain(value) || Object.keys(value).length === 0) return false
  let nonOff = false
  for (const level of Object.keys(value)) {
    if (!(THINKING_LEVELS as readonly string[]).includes(level)) return false
    const wire = value[level]
    if (wire === null) {
      if (level !== 'off') return false
      continue
    }
    if (typeof wire !== 'string' || wire.length === 0) return false
    if (level !== 'off') nonOff = true
  }
  return nonOff
}

function userEntry(user: unknown, name: string): Record<string, unknown> {
  const providers = isPlain(user) && isPlain(user.providers) ? user.providers : null
  return providers !== null && isPlain(providers[name]) ? providers[name] : {}
}

function resolvedEntry(value: unknown, name: string): Record<string, unknown> | null {
  const providers = isPlain(value) && isPlain(value.providers) ? value.providers : null
  return providers !== null && isPlain(providers[name]) ? providers[name] : null
}

/** Build the full view for one provider. */
async function buildProviderView(
  ctx: Context,
  entry: LlmConfigurableProvider,
  userSection: unknown,
  resolved: unknown,
): Promise<ProviderCapabilityView> {
  const name = entry.provider
  const up = userEntry(userSection, name)
  const vp = resolvedEntry(resolved, name)
  const hasUserModels = Array.isArray(up.models)
  const hasResolvedModels = vp !== null && Array.isArray(vp.models) && vp.models.length > 0
  const perModel = hasUserModels ? 'models' : (entry.declared === false ? 'modelOverrides' : null)

  const userModel = (id: string): Record<string, unknown> | null => {
    if (hasUserModels) {
      const m = (up.models as unknown[]).find((x) => isPlain(x) && x.id === id)
      return isPlain(m) ? m : null
    }
    if (perModel === 'modelOverrides' && isPlain(up.modelOverrides) && up.modelOverrides[id] !== undefined) {
      const override = up.modelOverrides[id]
      return isPlain(override) ? override : null
    }
    return null
  }

  const llm = ctx.get('llm')
  let effective: readonly LlmModelInfo[] = []
  let listError: string | null = null
  if (llm !== undefined) {
    try {
      const raw = await llm.listModels(name)
      effective = raw ?? []
    } catch (error) {
      listError = errMsg(error)
    }
  }

  const models: ModelCapabilityView[] = []
  for (const cm of effective) {
    if (typeof cm.id !== 'string') continue
    let reasoning: ModelCapabilityView['reasoning'] = null
    if (llm !== undefined) {
      try {
        const info: LlmResolvedModelInfo = await llm.resolveModelInfo(name, cm.id)
        if (info.reasoning && Array.isArray(info.reasoning.efforts)) {
          reasoning = {
            efforts: info.reasoning.efforts.map((eff) => ({
              id: eff.id,
              name: typeof eff.name === 'string' ? eff.name : null,
            })),
            defaultEffort: info.reasoning.defaultEffort ? String(info.reasoning.defaultEffort) : null,
          }
        }
      } catch {
        reasoning = null
      }
    }
    const um = userModel(cm.id)
    let editable = true
    let reason: ModelCapabilityView['reason'] = null
    if (perModel === null) {
      editable = false
      reason = 'basePinned'
    } else if (perModel === 'models' && (um === null || !isPlain(um))) {
      editable = false
      reason = 'notInUserList'
    }
    const userFields: ModelCapabilityFields | null = isPlain(um) ? {
      input: Array.isArray(um.input) && um.input.length > 0 ? (um.input as string[]).slice() : null,
      reasoningEfforts: um.reasoningEfforts === false
        ? false
        : (isPlain(um.reasoningEfforts) && Object.keys(um.reasoningEfforts).length > 0
          ? { ...(um.reasoningEfforts as Record<string, string | null>) }
          : null),
    } : null
    models.push({
      id: cm.id,
      name: typeof cm.name === 'string' && cm.name.length > 0 ? cm.name : cm.id,
      modalities: Array.isArray(cm.inputModalities) && cm.inputModalities.length > 0
        ? (cm.inputModalities as string[]).slice()
        : null,
      reasoning,
      user: userFields,
      editable,
      reason,
    })
  }

  return {
    id: name,
    displayName: typeof entry.displayName === 'string' && entry.displayName.length > 0 ? entry.displayName : name,
    declared: entry.declared === true,
    configured: vp !== null,
    perModel,
    listError,
    defaultReasoning: vp !== null && typeof vp.reasoning === 'string' ? String(vp.reasoning) : null,
    defaultInput: {
      available: hasResolvedModels,
      current: vp !== null && Array.isArray(vp.defaultInput) && vp.defaultInput.length > 0
        ? (vp.defaultInput as string[]).slice()
        : null,
    },
    models,
  }
}

/** Read the view plus write facts from the settings and llm seams. */
export async function readCapabilityView(ctx: Context): Promise<CapabilityViewResult> {
  const settings = ctx.get('settings')
  const llm = ctx.get('llm')
  if (settings === undefined || llm === undefined) {
    throw new Error('settings and llm services are required by dsh-model-capability-enhancement')
  }
  const ns = SETTINGS_NS
  const descriptor = settings.describe({ redactSecrets: true })
    .find(candidate => candidate.ns === ns)
  if (descriptor === undefined) {
    throw new Error(`llm-pi-ai settings section is not registered (${SETTINGS_NS})`)
  }
  const entries: readonly LlmConfigurableProvider[] = llm.listConfigurableProviders()
  const providers: ProviderCapabilityView[] = []
  for (const entry of entries) {
    // Only hand-declared (custom) routes: pi-ai's built-in catalog routes are
    // managed by the Models page, not by this section.
    if (entry.settingsNs !== SETTINGS_NS || entry.declared !== true) continue
    providers.push(await buildProviderView(ctx, entry, descriptor.user, descriptor.value))
  }
  return {
    ok: true,
    ns: SETTINGS_NS,
    writable: settings.writable,
    revision: typeof descriptor.revision === 'number' ? descriptor.revision : 0,
    levels: [...THINKING_LEVELS],
    providers,
  }
}

/** Persist one set of capability edits as path ops with revision protection. */
export async function applyCapabilityEdits(
  ctx: Context,
  payload: ApplyPayload,
): Promise<CapabilityApplyResult> {
  const settings = ctx.get('settings')
  const llm = ctx.get('llm')
  if (settings === undefined || llm === undefined) {
    return fail('error', 'settings and llm services are required by dsh-model-capability-enhancement')
  }
  if (!isPlain(payload)) return fail('invalid', 'payload must be an object')
  const name = payload.provider
  if (typeof name !== 'string' || name.length === 0) return fail('invalid', 'provider is required')
  const entries: readonly LlmConfigurableProvider[] = llm.listConfigurableProviders()
  const entry = entries.find(e => e.provider === name && e.settingsNs === SETTINGS_NS)
  if (entry === undefined || entry.declared !== true) {
    return fail('unsupported', 'route not found or not a hand-declared llm-pi-ai provider: ' + name)
  }

  const defaultReasoning = payload.defaultReasoning === undefined ? KEEP : payload.defaultReasoning
  const defaultInput = payload.defaultInput === undefined ? KEEP : payload.defaultInput
  const rawDrafts = Array.isArray(payload.models) ? payload.models : []
  if (defaultReasoning !== KEEP && defaultReasoning !== REVERT
    && !(THINKING_LEVELS as readonly string[]).includes(defaultReasoning)) {
    return fail('invalid', 'defaultReasoning must be a known level, "KEEP" or "REVERT"')
  }
  if (defaultInput !== KEEP && defaultInput !== REVERT && !validInput(defaultInput)) {
    return fail('invalid', 'defaultInput must be [text], [text image], "KEEP" or "REVERT"')
  }

  const byId = new Map<string, ModelDraft>()
  for (const raw of rawDrafts) {
    if (!isPlain(raw) || typeof raw.id !== 'string' || raw.id.length === 0) {
      return fail('invalid', 'each models entry needs a non-empty string id')
    }
    const input = raw.input === undefined ? KEEP : raw.input
    const efforts = raw.reasoningEfforts === undefined ? KEEP : raw.reasoningEfforts
    if (input !== KEEP && input !== REVERT && !validInput(input)) {
      return fail('invalid', 'model ' + raw.id + ': invalid input')
    }
    if (efforts !== KEEP && efforts !== REVERT && !validEfforts(efforts)) {
      return fail('invalid', 'model ' + raw.id + ': invalid reasoningEfforts (levels: '
        + THINKING_LEVELS.join('/')
        + '; only off may be valueless; at least one level beyond off; wire values must be non-empty strings)')
    }
    const prev = byId.get(raw.id)
    if (prev === undefined) {
      byId.set(raw.id, { id: raw.id, input, reasoningEfforts: efforts })
    } else {
      if (input !== KEEP) prev.input = input
      if (efforts !== KEEP) prev.reasoningEfforts = efforts
    }
  }
  const drafts = [...byId.values()]

  const ns = SETTINGS_NS
  const descriptor = settings.describe({ redactSecrets: true })
    .find(candidate => candidate.ns === ns)
  if (descriptor === undefined) {
    return fail('error', 'llm-pi-ai settings section not registered')
  }
  const up = userEntry(descriptor.user, name)
  const vp = resolvedEntry(descriptor.value, name)
  const hasUserModels = Array.isArray(up.models)
  const hasResolvedModels = vp !== null && Array.isArray(vp.models) && vp.models.length > 0

  const ops: { op: 'set' | 'unset'; path: string[]; value?: unknown }[] = []
  const pathFor = (parts: string[]): string[] => ['providers', name, ...parts]

  if (defaultReasoning !== KEEP) {
    if (defaultReasoning === REVERT) ops.push({ op: 'unset', path: pathFor(['reasoning']) })
    else ops.push({ op: 'set', path: pathFor(['reasoning']), value: defaultReasoning })
  }
  if (defaultInput !== KEEP) {
    if (!hasResolvedModels) {
      return fail('unsupported', name + ' has no model list, so defaultInput would have no effect; configure its model list first')
    }
    if (defaultInput === REVERT) ops.push({ op: 'unset', path: pathFor(['defaultInput']) })
    else ops.push({ op: 'set', path: pathFor(['defaultInput']), value: [...defaultInput] })
  }

  if (drafts.length > 0) {
    if (hasUserModels) {
      const list = up.models as unknown[]
      const next = list.map((m) => (isPlain(m) ? { ...m } : m))
      for (const d of drafts) {
        const idx = list.findIndex((m) => isPlain(m) && m.id === d.id)
        if (idx === -1) {
          return fail('unsupported', 'model ' + d.id + ' is not in the user models list of ' + name
            + ' (it may come from the composition base); edit the settings file directly')
        }
        const target = next[idx] as Record<string, unknown>
        if (d.input !== KEEP) {
          if (d.input === REVERT) delete target.input
          else target.input = [...(d.input as string[])]
        }
        if (d.reasoningEfforts !== KEEP) {
          if (d.reasoningEfforts === REVERT) delete target.reasoningEfforts
          else if (d.reasoningEfforts === false) target.reasoningEfforts = false
          else target.reasoningEfforts = { ...d.reasoningEfforts }
        }
      }
      ops.push({ op: 'set', path: pathFor(['models']), value: next })
    } else if (entry.declared === false) {
      for (const d of drafts) {
        const curSrc = isPlain(up.modelOverrides) && isPlain(up.modelOverrides[d.id])
          ? up.modelOverrides[d.id] as Record<string, unknown>
          : null
        const cur = curSrc === null ? {} : { ...curSrc }
        if (d.input !== KEEP) {
          if (d.input === REVERT) delete cur.input
          else cur.input = [...(d.input as string[])]
        }
        if (d.reasoningEfforts !== KEEP) {
          if (d.reasoningEfforts === REVERT) delete cur.reasoningEfforts
          else if (d.reasoningEfforts === false) cur.reasoningEfforts = false
          else cur.reasoningEfforts = { ...d.reasoningEfforts }
        }
        if (Object.keys(cur).length === 0) ops.push({ op: 'unset', path: pathFor(['modelOverrides', d.id]) })
        else ops.push({ op: 'set', path: pathFor(['modelOverrides', d.id]), value: cur })
      }
    } else {
      return fail('unsupported', 'the model list of ' + name
        + ' comes from the composition base layer; edit the settings file directly for: '
        + drafts.map(d => d.id).join(', '))
    }
  }

  if (ops.length === 0) {
    return { ok: true, revision: typeof descriptor.revision === 'number' ? descriptor.revision : null, noop: true }
  }
  try {
    await settings.mutate(ns, ops, descriptor.revision)
  } catch (error) {
    if (error instanceof SettingsConflictError) {
      return { ok: false, code: 'conflict', message: 'the settings document changed meanwhile; refresh and retry' }
    }
    return fail('rejected', errMsg(error))
  }
  return {
    ok: true,
    revision: typeof descriptor.revision === 'number' ? descriptor.revision + 1 : null,
    noop: false,
  }
}

/** Send one JSON response body with a status code. */
function sendJson(res: Parameters<WebRoute['handler']>[1], status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** Register the JSON routes through an optional webserver inject. */
export function mountCapabilityUi(ctx: Context, prefix: string): void {
  const viewRoute: WebRoute = {
    kind: 'exact',
    path: `${prefix}/view`,
    handler: async (_req, res) => {
      try {
        sendJson(res, 200, await readCapabilityView(ctx))
      } catch (error) {
        sendJson(res, 500, { ok: false, code: 'error', message: errMsg(error) })
      }
    },
  }

  const applyRoute: WebRoute = {
    kind: 'exact',
    path: `${prefix}/apply`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      try {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const raw = Buffer.concat(chunks).toString('utf8')
        const body = JSON.parse(raw.length > 0 ? raw : '{}') as unknown
        if (!isPlain(body)) {
          sendJson(res, 400, { ok: false, code: 'invalid', message: 'payload must be a JSON object' })
          return
        }
        const outcome = await applyCapabilityEdits(ctx, body as ApplyPayload)
        sendJson(res, outcome.ok ? 200 : 409, outcome)
      } catch (error) {
        sendJson(res, 500, { ok: false, code: 'rejected', message: errMsg(error) })
      }
    },
  }

  ctx.effect(() => ctx.webServer.register(viewRoute), 'dsh-model-capability-enhancement: view route')
  ctx.effect(() => ctx.webServer.register(applyRoute), 'dsh-model-capability-enhancement: apply route')
}
