/**
 * The Model Capability settings section (Ant Design).
 *
 * Renders one card per hand-declared llm-pi-ai provider. Each card edits:
 * - the provider default reasoning level (`reasoning`),
 * - the provider default input for its model list (`defaultInput`),
 * - per model: input modalities (`input`) and a reasoning-effort wire map
 *   (`reasoningEfforts`) — `false` = non-reasoning, absent = non-reasoning,
 *   a map = explicit wire strings per level.
 *
 * Components come from Ant Design (CSS-in-JS, tree-shaken to the ones used
 * here). A top-level `App` provides the `message` context so apply feedback
 * (saved / conflict / validation) surfaces as toast notifications that follow
 * the active theme.
 *
 * UI behaviors:
 * - the currently-selected option inside every dropdown menu is marked with
 *   the Ant Design CheckOutlined icon,
 * - provider cards start collapsed; clicking the card header expands/collapses
 *   the card (collapsed headers show the model count),
 * - one global Refresh button at the top of the section reloads the latest
 *   model configuration list from the host (antd spinner inside the button
 *   while running, a "refreshed" toast on a successful manual refresh).
 * @module dsh-model-capability-enhancement/client/ModelCapabilitySection
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
// On-demand Ant Design imports (no `exports` map on antd, so subpath ESM
// entries keep the bundle tree-shaken instead of pulling the whole library).
import CheckOutlined from '@ant-design/icons/es/icons/CheckOutlined'
import RightOutlined from '@ant-design/icons/es/icons/RightOutlined'
import Alert from 'antd/es/alert'
import App from 'antd/es/app'
import Button from 'antd/es/button'
import Card from 'antd/es/card'
import Checkbox from 'antd/es/checkbox'
import ConfigProvider from 'antd/es/config-provider'
import Divider from 'antd/es/divider'
import Empty from 'antd/es/empty'
import Input from 'antd/es/input'
import Select from 'antd/es/select'
import Skeleton from 'antd/es/skeleton'
import Space from 'antd/es/space'
import Tag from 'antd/es/tag'
import Typography from 'antd/es/typography'
import antdTheme from 'antd/es/theme'
import type { CapabilityStore, ModelCapabilityView, ProviderCapabilityView } from './store.ts'
import type { ModelCapabilityKey } from './locales.ts'

const { Text } = Typography

/** Injected dependencies of the section (slot `inject`). */
export interface ModelCapabilityInjected {
  /** The section store (route transport). */
  controller: CapabilityStore
  /** Bound section copy. */
  t: (key: ModelCapabilityKey) => string
  /** Theme color scheme snapshot (light/dark) for the Ant Design palette. */
  colorScheme: {
    getSnapshot: () => 'light' | 'dark'
    subscribe: (fn: () => void) => () => void
  }
}

/** Props delivered by the slot outlet plus the shell-owned `close`. */
export type ModelCapabilityProps = Partial<ModelCapabilityInjected & { close: () => void }>

/** Reasoning levels in canonical order (mirrors the Host side). */
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** A model's editable draft (levels as checkbox + wire rows). */
interface LevelDraft {
  on: boolean
  wire: string
}

interface ModelDraft {
  input: string[] | null
  mode: 'custom' | 'false' | 'off'
  levels: Record<string, LevelDraft>
}

/** The provider card's whole editable draft. */
interface ProviderDraft {
  defaultReasoning: string | null
  defaultInput: string[] | null
  models: Record<string, ModelDraft>
}

function emptyLevels(): Record<string, LevelDraft> {
  const out: Record<string, LevelDraft> = {}
  for (const lv of LEVELS) out[lv] = { on: false, wire: '' }
  return out
}

function levelsToDict(levels: Record<string, LevelDraft>): Record<string, string | null> | false {
  const out: Record<string, string | null> = {}
  let nonOff = false
  for (const lv of LEVELS) {
    const e = levels[lv]
    if (!e || !e.on) continue
    if (lv === 'off') { out[lv] = null; continue }
    out[lv] = e.wire
    nonOff = true
  }
  return nonOff ? out : false
}

function canonInput(v: string[] | null | undefined): string {
  if (Array.isArray(v) && v.length > 0) return [...v].sort().join(',')
  return '∅'
}

function canonLevels(levels: Record<string, LevelDraft>): string {
  return LEVELS.map((lv) => {
    const e = levels[lv]
    return `${lv}:${e?.on === true ? '1' : '0'}:${e?.on === true ? String(e.wire ?? '') : ''}`
  }).join('|')
}

const levelOptions = LEVELS.map((lv) => ({ value: lv, label: lv }))
const inputOptions = [
  { value: 'text', label: 'text' },
  { value: 'text+image', label: 'text + image' },
]

/** CheckOutlined marks the option currently selected in a dropdown menu. */
const selectedIcon = <CheckOutlined />

/** One model row: modality select + reasoning mode select + optional level map. */
function ModelRow(props: {
  model: ModelCapabilityView
  draft: ModelDraft
  editable: boolean
  t: (key: ModelCapabilityKey) => string
  onChange: (draft: ModelDraft) => void
}): ReactElement {
  const { model: m, draft, editable, t, onChange } = props

  const setLevel = (lv: string, patch: Partial<LevelDraft>): void => {
    const levels = emptyLevels()
    for (const lv2 of LEVELS) {
      const old = draft.levels[lv2]
      if (old) levels[lv2] = { on: old.on === true, wire: typeof old.wire === 'string' ? old.wire : '' }
    }
    levels[lv] = { ...levels[lv], ...patch }
    onChange({ ...draft, levels })
  }

  const onMode = (value: string): void => {
    if (value === 'custom') {
      const levels = emptyLevels()
      if (m.reasoning && Array.isArray(m.reasoning.efforts)) {
        for (const eff of m.reasoning.efforts) {
          if ((LEVELS as readonly string[]).includes(eff.id)) levels[eff.id] = { on: true, wire: String(eff.id) }
        }
      }
      for (const lv of LEVELS) {
        const old = draft.levels[lv]
        if (old && old.on === true) {
          levels[lv] = { on: true, wire: old.wire.length > 0 ? old.wire : String(lv) }
        }
      }
      onChange({ ...draft, mode: 'custom', levels })
      return
    }
    onChange({ ...draft, mode: value as ModelDraft['mode'] })
  }

  const modeOptions = [
    { value: 'off', label: t('modeOff') },
    { value: 'custom', label: t('modeCustom') },
  ]

  return (
    <Card size="small" variant="borderless" styles={{ body: { padding: '10px 12px' } }}>
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <Space wrap align="baseline" size={8}>
          <Text strong>{m.name}</Text>
          <Text type="secondary" style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }}>{m.id}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {m.modalities !== null ? m.modalities.join(' + ') : t('modalitiesUnknown')}
          </Text>
          {m.reasoning !== null
            ? <Text type="secondary" style={{ fontSize: 12 }}>{t('effortsEffective')}: {m.reasoning.efforts.map(e => e.id).join(', ')}</Text>
            : <Text type="secondary" style={{ fontSize: 12 }}>{t('noReasoningReported')}</Text>}
          {!editable
            ? <Text type="secondary" style={{ fontSize: 12 }}>{m.reason === 'basePinned' ? t('notEditableBase') : t('notEditableNotInList')}</Text>
            : null}
        </Space>
        {editable ? (
          <Space size={16} wrap align="start">
            <Space direction="vertical" size={4}>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('modalities')}</Text>
              <Select
                size="small"
                style={{ minWidth: 180 }}
                value={Array.isArray(draft.input) ? draft.input.join('+') : undefined}
                placeholder={t('unsetFallback')}
                options={inputOptions}
                menuItemSelectedIcon={selectedIcon}
                allowClear
                onChange={(value) => onChange({
                  ...draft,
                  input: value === undefined ? null : value.split('+'),
                })}
              />
            </Space>
            <Space direction="vertical" size={4}>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('reasoning')}</Text>
              <Select
                size="small"
                style={{ minWidth: 180 }}
                value={draft.mode}
                options={modeOptions}
                menuItemSelectedIcon={selectedIcon}
                onChange={onMode}
              />
              <Text type="secondary" style={{ fontSize: 12 }}>{t('reasoningHintDeclared')}</Text>
            </Space>
          </Space>
        ) : null}
        {draft.mode === 'custom' ? (
          <div style={{ borderTop: '1px dashed rgba(128,128,128,.3)', paddingTop: 8, marginTop: 4 }}>
            <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 6 }}>{t('customHint')}</Text>
            {LEVELS.map((lv) => {
              const e = draft.levels[lv] ?? { on: false, wire: '' }
              return (
                // Fixed three-column grid: level label | checkbox | wire input
                // stay vertically aligned across every row.
                <div
                  key={lv}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '84px 28px 1fr',
                    alignItems: 'center',
                    gap: 8,
                    marginBottom: 4,
                    minHeight: 28,
                  }}
                >
                  <Text style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #5c6470)' }}>{lv}</Text>
                  <Checkbox
                    checked={e.on === true}
                    onChange={(ev) => setLevel(lv, {
                      on: ev.target.checked,
                      // Checking a level defaults its wire value to the level's
                      // own name when the field is still empty; a value the
                      // user already typed always wins (and unchecking keeps
                      // it, so re-checking restores it).
                      ...(ev.target.checked && e.wire === '' ? { wire: lv } : {}),
                    })}
                  />
                  <Input
                    size="small"
                    style={{ width: '100%', maxWidth: 300 }}
                    value={lv === 'off' ? '' : (e.on === true ? e.wire : '')}
                    disabled={lv === 'off' || e.on !== true}
                    placeholder={lv === 'off' ? t('offWireHint') : lv}
                    onChange={(ev) => setLevel(lv, { wire: ev.target.value })}
                  />
                </div>
              )
            })}
          </div>
        ) : null}
      </Space>
    </Card>
  )
}

/**
 * One provider card: default level, default input, and per-model rows.
 * Collapsed by default; clicking the card header toggles expand/collapse.
 */
function ProviderCard(props: {
  view: ProviderCapabilityView
  writable: boolean
  t: (key: ModelCapabilityKey) => string
  onApply: (payload: Record<string, unknown>) => void
  busy: boolean
}): ReactElement {
  const { view, writable, t, onApply, busy } = props
  const [collapsed, setCollapsed] = useState(true)

  const initial = useMemo(() => {
    const models: Record<string, ModelDraft> = {}
    for (const m of view.models) {
      const u = m.user
      const input = u?.input !== null && Array.isArray(u?.input) && u!.input!.length > 0
        ? [...u!.input!] : null
      if (u?.reasoningEfforts !== null && u?.reasoningEfforts !== false && typeof u?.reasoningEfforts === 'object') {
        const levels = emptyLevels()
        for (const lv of LEVELS) {
          const wire = (u!.reasoningEfforts as Record<string, string | null>)[lv]
          if (wire !== undefined) levels[lv] = { on: true, wire: typeof wire === 'string' ? wire : '' }
        }
        models[m.id] = { input, mode: 'custom', levels }
      } else if (u?.reasoningEfforts === false) {
        models[m.id] = { input, mode: 'false', levels: emptyLevels() }
      } else {
        models[m.id] = { input, mode: 'off', levels: emptyLevels() }
      }
    }
    return {
      defaultReasoning: view.defaultReasoning,
      defaultInput: view.defaultInput.available && Array.isArray(view.defaultInput.current) && view.defaultInput.current.length > 0
        ? [...view.defaultInput.current] : null,
      models,
    }
  }, [view])

  const [draft, setDraft] = useState<ProviderDraft>(initial)
  const { message } = App.useApp()

  // Re-seed when the provider view changes identity (a reload happened).
  useEffect(() => { setDraft(initial) }, [initial])

  const setField = (patch: Partial<ProviderDraft>): void => setDraft(d => ({ ...d, ...patch }))
  const setModel = (id: string, md: ModelDraft): void => {
    setDraft(d => ({ ...d, models: { ...d.models, [id]: md } }))
  }

  const dirty = draft.defaultReasoning !== initial.defaultReasoning
    || canonInput(draft.defaultInput) !== canonInput(initial.defaultInput)
    || view.models.some((m) => {
      const d = draft.models[m.id]
      const i = initial.models[m.id]
      if (d === undefined || i === undefined) return false
      return d.mode !== i.mode
        || canonInput(d.input) !== canonInput(i.input)
        || (d.mode === 'custom' && canonLevels(d.levels) !== canonLevels(i.levels))
    })

  const validate = (): string | null => {
    for (const m of view.models) {
      const d = draft.models[m.id]
      if (!d || d.mode !== 'custom') continue
      let nonOff = false
      for (const lv of LEVELS) {
        const e = d.levels[lv]
        if (!e || e.on !== true) continue
        if (lv === 'off') continue
        if (typeof e.wire !== 'string' || e.wire.trim().length === 0) return t('errWire')
        nonOff = true
      }
      if (!nonOff) return t('errWire')
    }
    return null
  }

  const buildPayload = (): Record<string, unknown> => {
    const payload: Record<string, unknown> = { provider: view.id }
    payload.defaultReasoning = draft.defaultReasoning === initial.defaultReasoning
      ? 'KEEP'
      : (draft.defaultReasoning === null ? 'REVERT' : draft.defaultReasoning)
    if (view.defaultInput.available) {
      payload.defaultInput = canonInput(draft.defaultInput) === canonInput(initial.defaultInput)
        ? 'KEEP'
        : (draft.defaultInput === null ? 'REVERT' : draft.defaultInput)
    }
    const models: Record<string, unknown>[] = []
    for (const m of view.models) {
      const md = draft.models[m.id]
      const mi = initial.models[m.id]
      if (md === undefined || mi === undefined) continue
      const inputSame = canonInput(md.input) === canonInput(mi.input)
      const modeSame = md.mode === mi.mode
      const levelsSame = (md.mode !== 'custom' && mi.mode !== 'custom')
        || (md.mode === 'custom' && mi.mode === 'custom' && canonLevels(md.levels) === canonLevels(mi.levels))
      if (inputSame && modeSame && levelsSame) continue
      const input = inputSame ? 'KEEP' : (md.input === null ? 'REVERT' : md.input)
      let efforts: unknown
      if (md.mode === mi.mode) {
        efforts = md.mode === 'custom'
          ? (canonLevels(md.levels) === canonLevels(mi.levels) ? 'KEEP' : levelsToDict(md.levels))
          : 'KEEP'
      } else if (md.mode === 'custom') {
        efforts = levelsToDict(md.levels)
      } else if (md.mode === 'false') {
        efforts = false
      } else {
        efforts = 'REVERT'
      }
      models.push({ id: m.id, input, reasoningEfforts: efforts })
    }
    payload.models = models
    return payload
  }

  const submit = (): void => {
    if (!writable || busy) return
    const problem = validate()
    if (problem !== null) { message.error(problem); return }
    onApply(buildPayload())
  }

  return (
    <Card
      title={(
        <div
          role="button"
          aria-expanded={!collapsed}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}
          onClick={() => setCollapsed((c) => !c)}
        >
          <RightOutlined
            aria-hidden="true"
            style={{
              fontSize: 12,
              transition: 'transform 150ms ease',
              transform: collapsed ? 'none' : 'rotate(90deg)',
            }}
          />
          <span>{view.displayName}</span>
          <Text type="secondary" style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }}>{view.id}</Text>
          <Tag color="blue">{t('tagDeclared')}</Tag>
          {view.configured ? <Tag color="green">{t('tagConfigured')}</Tag> : null}
          {collapsed && view.models.length > 0
            ? <Text type="secondary" style={{ fontSize: 12 }}>{view.models.length} {t('modelsUnit')}</Text>
            : null}
        </div>
      )}
    >
      {collapsed ? null : (
        <div>
          {view.listError !== null ? (
            <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`${t('listError')} ${view.listError}`} />
          ) : null}

          <Space size={24} wrap align="start" style={{ marginBottom: 12 }}>
            <Space direction="vertical" size={4}>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('defaultReasoning')}</Text>
              <Select
                style={{ minWidth: 180 }}
                value={draft.defaultReasoning === null ? undefined : draft.defaultReasoning}
                placeholder={initial.defaultReasoning === null ? t('noDefault') : t('unset')}
                options={levelOptions}
                menuItemSelectedIcon={selectedIcon}
                allowClear
                disabled={!writable}
                onChange={(value) => setField({ defaultReasoning: value ?? null })}
              />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('current')}: {initial.defaultReasoning ?? t('unset')}
              </Text>
            </Space>
            {view.defaultInput.available ? (
              <Space direction="vertical" size={4}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('defaultInput')}</Text>
                <Select
                  style={{ minWidth: 180 }}
                  value={Array.isArray(draft.defaultInput) ? draft.defaultInput.join('+') : undefined}
                  placeholder={initial.defaultInput === null ? t('noDefault') : t('resetDefault')}
                  options={inputOptions}
                  menuItemSelectedIcon={selectedIcon}
                  allowClear
                  disabled={!writable}
                  onChange={(value) => setField({ defaultInput: value === undefined ? null : value.split('+') })}
                />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('current')}: {initial.defaultInput !== null ? initial.defaultInput.join(' + ') : t('unset')}
                </Text>
              </Space>
            ) : null}
          </Space>

          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            {view.models.length === 0 ? <Text type="secondary" style={{ fontSize: 12 }}>{t('noModels')}</Text> : null}
            {view.models.map((m) => (
              <ModelRow
                key={m.id}
                model={m}
                draft={draft.models[m.id] ?? { input: null, mode: 'off', levels: emptyLevels() }}
                editable={m.editable === true && writable}
                t={t}
                onChange={(md) => setModel(m.id, md)}
              />
            ))}
          </Space>

          <Divider style={{ margin: '12px 0' }} />
          <Space size={12}>
            <Button
              type="primary"
              loading={busy}
              disabled={!dirty || !writable}
              onClick={submit}
            >
              {t('apply')}
            </Button>
          </Space>
        </div>
      )}
    </Card>
  )
}

/**
 * Render the Model Capability settings section.
 * @param props - slot-delivered injected dependencies and shell chrome.
 * @returns the section, or null while the shell has not injected yet.
 */
export function ModelCapabilitySection(props: ModelCapabilityProps): ReactElement | null {
  const { controller, t, colorScheme } = props
  if (controller === undefined || t === undefined || colorScheme === undefined) return null
  return <Loaded controller={controller} t={t} colorScheme={colorScheme} />
}

function Loaded({ controller, t, colorScheme }: ModelCapabilityInjected): ReactElement {
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot)
  const scheme = useSyncExternalStore(colorScheme.subscribe, colorScheme.getSnapshot)

  const busy = state.saving

  // Global refresh: reload the latest model configuration list from the host
  // for every provider. The button itself carries the loading state (antd
  // spinner); a manual refresh that lands on 'ready' ticks `refreshSeq`,
  // which `RefreshToastBridge` turns into a success toast.
  const [refreshing, setRefreshing] = useState(false)
  const refreshingRef = useRef(false)
  const [refreshSeq, setRefreshSeq] = useState(0)
  const reload = (): void => {
    if (refreshingRef.current) return
    if (state.status === 'idle' || state.status === 'loading') return
    refreshingRef.current = true
    setRefreshing(true)
    void controller.load().then(() => {
      // `load()` never rejects; it settles with the final status. Tick only
      // when it landed on 'ready' so a failed refresh stays silent.
      if (controller.store.getSnapshot().status === 'ready') setRefreshSeq((n) => n + 1)
    }).finally(() => {
      refreshingRef.current = false
      setRefreshing(false)
    })
  }

  useEffect(() => {
    if (state.status === 'idle') void controller.load()
  }, [state.status, controller])

  const apply = (payload: Record<string, unknown>): void => { void controller.apply(payload) }

  return (
    <ConfigProvider
      theme={{
        algorithm: scheme === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: scheme === 'dark' ? '#4f7cff' : '#2f6bff',
          borderRadius: 8,
        },
        components: {
          Select: {
            optionSelectedBg: scheme === 'dark' ? 'rgba(79,124,255,.28)' : 'rgba(47,107,255,.14)',
            optionSelectedColor: scheme === 'dark' ? '#bcd0ff' : '#1d4ed8',
            optionActiveBg: scheme === 'dark' ? 'rgba(79,124,255,.16)' : 'rgba(47,107,255,.08)',
          },
        },
      }}
    >
      <App>
        <ToastBridge
          saved={state.saved === true}
          saveError={state.saveError}
          t={t}
        />
        <RefreshToastBridge seq={refreshSeq} t={t} />
        <div style={{ maxWidth: 860, display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 2px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <Typography.Title level={5} style={{ margin: 0 }}>{t('title')}</Typography.Title>
              <Typography.Paragraph type="secondary" style={{ margin: '4px 0 0' }}>{t('subtitle')}</Typography.Paragraph>
            </div>
            <Button
              size="small"
              loading={refreshing}
              disabled={state.saving}
              onClick={reload}
            >
              {t('refresh')}
            </Button>
          </div>

          {state.status === 'loading' && state.providers.length === 0
            ? <Skeleton active paragraph={{ rows: 6 }} />
            : null}
          {state.status === 'error'
            ? <Alert type="error" showIcon message={`${t('loadError')} ${state.error ?? ''}`} />
            : null}
          {state.status === 'ready' && !state.writable
            ? <Alert type="info" showIcon message={t('readonly')} />
            : null}
          {state.status === 'ready' && state.providers.length === 0
            ? <Empty description={t('noProviders')} style={{ padding: '24px 0' }} />
            : null}

          {state.status === 'ready'
            ? state.providers.map((p) => (
              <ProviderCard
                key={`${p.id}#${state.revision}`}
                view={p}
                writable={state.writable}
                t={t}
                onApply={apply}
                busy={busy}
              />
            ))
            : null}

          <Text type="secondary" style={{ fontSize: 12, opacity: .8 }}>{t('foot')}</Text>
        </div>
      </App>
    </ConfigProvider>
  )
}

/** Renders one toast per apply outcome using the App message context. */
function ToastBridge(props: {
  saved: boolean
  saveError: string | undefined
  t: (key: ModelCapabilityKey) => string
}): ReactElement | null {
  const { message } = App.useApp()
  const last = useRef<{ saved: boolean; saveError?: string } | null>(null)

  useEffect(() => {
    const outcomeKey = props.saved ? 'saved' : `error:${props.saveError ?? ''}`
    if (last.current !== null
      && last.current.saved === props.saved
      && last.current.saveError === props.saveError) {
      return
    }
    if (!props.saved && props.saveError === undefined) return
    last.current = { saved: props.saved, saveError: props.saveError }
    if (props.saved) {
      message.success(props.t('saved'))
    } else if (props.saveError === 'settings-conflict') {
      message.warning(props.t('conflict'))
    } else {
      message.error(props.saveError ?? 'apply failed')
    }
  }, [props.saved, props.saveError, message, props.t])

  return null
}

/** Fires a "refreshed" toast once per successful manual refresh tick. */
function RefreshToastBridge(props: {
  seq: number
  t: (key: ModelCapabilityKey) => string
}): ReactElement | null {
  const { message } = App.useApp()
  const last = useRef(0)

  useEffect(() => {
    if (props.seq > 0 && props.seq > last.current) {
      last.current = props.seq
      message.success(props.t('refreshed'))
    }
  }, [props.seq, message, props.t])

  return null
}
