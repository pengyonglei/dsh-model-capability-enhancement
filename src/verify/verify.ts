/**
 * Offline verification for the capability view/apply logic: branch targets,
 * KEEP/REVERT semantics, and validator acceptance without touching a real
 * settings document (mock ctx seams only).
 */

import { applyCapabilityEdits, readCapabilityView, KEEP, REVERT, THINKING_LEVELS } from '../routes.ts'

let passed = 0
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
  passed += 1
}

/** A fake settings seam recording mutations like the real one validates them. */
function mockCtx(section: unknown) {
  let revision = 0
  let stored: unknown = section
  const settings = {
    writable: true,
    describe: () => [{
      ns: 'llm-pi-ai',
      revision,
      value: stored,
      user: stored,
    }],
    async mutate(ns: string, ops: readonly { op: 'set' | 'unset'; path: string[]; value?: unknown }[]): Promise<void> {
      if (ns !== 'llm-pi-ai') throw new Error(`unexpected ns ${ns}`)
      const root = structuredClone((stored as { providers?: Record<string, unknown> })) ?? {}
      const providers = root.providers ?? {}
      const target = providers[String(ops[0]?.path[1])] ?? {}
      for (const op of ops) {
        const rest = op.path.slice(2)
        if (op.op === 'set') {
          if (rest.length === 1) target[rest[0]] = op.value
        } else if (op.op === 'unset') {
          if (rest.length === 1) delete target[rest[0]]
        }
      }
      providers[String(ops[0]?.path[1])] = target
      root.providers = providers
      stored = root
      revision += 1
    },
  }
  const llm = {
    listConfigurableProviders: () => [{
      provider: 'ollma-local',
      displayName: 'ollama-local',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'ollma-local'],
      declared: true,
    }],
    listModels: async () => [{
      id: 'qwen3.8:latest',
      name: 'qwen3.8',
      inputModalities: ['text', 'image'],
    }],
    resolveModelInfo: async () => ({
      id: 'qwen3.8:latest',
      inputModalities: ['text', 'image'],
      reasoning: {
        efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'xhigh', name: 'Xhigh' }],
        defaultEffort: 'xhigh',
      },
    }),
  }
  return { ctx: { get: (name: string) => name === 'settings' ? settings : name === 'llm' ? llm : undefined }, stored: () => stored, revision: () => revision }
}

// --- view: only declared routes are listed ---------------------------------
{
  const { ctx } = mockCtx({ providers: { 'ollma-local': { models: [] } } })
  const view = await readCapabilityView(ctx)
  assert(view.ok === true, 'view succeeds')
  assert(view.providers.length === 1, 'view lists only the declared route')
  assert(view.providers[0]!.perModel === 'models', 'declared route with models list edits models[]')
  assert(view.levels.length === THINKING_LEVELS.length, 'view exposes all levels')
}

// --- apply: default reasoning writes providers.<id>.reasoning ---------------
{
  const { ctx, stored } = mockCtx({ providers: { 'ollma-local': { models: [{ id: 'qwen3.8:latest', name: 'qwen3.8' }] } } })
  const out = await applyCapabilityEdits(ctx, { provider: 'ollma-local', defaultReasoning: 'high' })
  assert(out.ok === true, 'defaultReasoning write ok')
  assert(!out.noop, 'defaultReasoning write is not a noop')
  const s = stored() as { providers: Record<string, Record<string, unknown>> }
  assert(s.providers['ollma-local']!.reasoning === 'high', 'reasoning landed at providers.ollma-local.reasoning')
}

// --- apply: REVERT deletes the key ------------------------------------------
{
  const { ctx, stored } = mockCtx({ providers: { 'ollma-local': { reasoning: 'xhigh', models: [] } } })
  const out = await applyCapabilityEdits(ctx, { provider: 'ollma-local', defaultReasoning: REVERT })
  assert(out.ok === true, 'REVERT write ok')
  const s = stored() as { providers: Record<string, Record<string, unknown>> }
  assert(!('reasoning' in s.providers['ollma-local']!), 'REVERT removes the reasoning key')
}

// --- apply: per-model input and reasoningEfforts land in models[] ------------
{
  const { ctx, stored } = mockCtx({
    providers: { 'ollma-local': { models: [{ id: 'qwen3.8:latest', name: 'qwen3.8', input: ['text', 'image'] }] } },
  })
  const out = await applyCapabilityEdits(ctx, {
    provider: 'ollma-local',
    models: [{
      id: 'qwen3.8:latest',
      input: ['text'],
      reasoningEfforts: { low: 'low', medium: 'medium' },
    }],
  })
  assert(out.ok === true, 'model edits ok')
  const s = stored() as { providers: Record<string, { models: Record<string, unknown>[] }> }
  const model = s.providers['ollma-local']!.models[0]!
  assert(JSON.stringify(model.input) === JSON.stringify(['text']), 'model input landed')
  assert(JSON.stringify(model.reasoningEfforts) === JSON.stringify({ low: 'low', medium: 'medium' }), 'model reasoningEfforts landed')
}

// --- apply: invalid reasoningEfforts rejected before any write ----------------
{
  const { ctx, stored } = mockCtx({ providers: { 'ollma-local': { models: [{ id: 'qwen3.8:latest', name: 'qwen3.8' }] } } })
  const before = JSON.stringify(stored())
  const bad = await applyCapabilityEdits(ctx, {
    provider: 'ollma-local',
    models: [{ id: 'qwen3.8:latest', reasoningEfforts: { high: '' } }],
  })
  assert(bad.ok === false, 'empty wire value is rejected')
  assert(JSON.stringify(stored()) === before, 'rejected write leaves the document untouched')
  const allOff = await applyCapabilityEdits(ctx, {
    provider: 'ollma-local',
    models: [{ id: 'qwen3.8:latest', reasoningEfforts: { off: null } }],
  })
  assert(allOff.ok === false, 'all-off dict is rejected')
}

// --- apply: unknown level rejected --------------------------------------------
{
  const { ctx } = mockCtx({ providers: { 'ollma-local': { models: [] } } })
  const out = await applyCapabilityEdits(ctx, { provider: 'ollma-local', defaultReasoning: 'turbo' })
  assert(out.ok === false, 'unknown level is rejected')
}

// --- apply: catalog routes are not writable here ------------------------------
{
  const settings = {
    writable: true,
    describe: () => [{ ns: 'llm-pi-ai', revision: 0, value: {}, user: {} }],
    mutate: async () => { throw new Error('must not be called') },
  }
  const llm = {
    listConfigurableProviders: () => [{
      provider: 'openai',
      displayName: 'OpenAI',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai'],
      declared: false,
    }],
    listModels: async () => [],
    resolveModelInfo: async () => ({ id: 'x', inputModalities: ['text'] }),
  }
  const ctx = { get: (name: string) => name === 'settings' ? settings : name === 'llm' ? llm : undefined }
  const out = await applyCapabilityEdits(ctx, { provider: 'openai', defaultReasoning: 'high' })
  assert(out.ok === false, 'catalog route writes are refused')
  assert(out.code === 'unsupported', 'refusal carries the unsupported code')
}

console.log(`verify passed: ${passed} assertions`)
