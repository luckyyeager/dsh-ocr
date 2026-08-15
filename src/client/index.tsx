/**
 * @dsh-external/dsh-ocr — client half.
 *
 * OcrSettingsCard：注册进 `settings.plugin.item`（设置 > 插件 页的配置卡片）。
 * 读写 host 侧 `dsh-ocr` settings 命名空间：
 * - 顶层开关/标量（enabled、toolEnabled、defaultProvider、timeoutMs、
 *   maxImageBytes）经 settingsScope.set/unset 直接提交；
 * - 供应商嵌套字段经 connection API 的 settings.mutate 按 path 写入，
 *   保存按钮一次性提交该供应商的 staged 编辑；apiKey / secretKey 为
 *   role('secret') 写only字段——字面值永不下发浏览器，输入框始终留空，
 *   仅以 user 层存在性显示"已配置"徽标。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Context } from 'cordis'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'

const NS = 'ocr'
const SETTINGS_NS = 'dsh-ocr'

/** 内置预设 id（与 host engine.PRESETS 保持一致；仅用于下拉候选）。 */
const PRESET_IDS = ['baidu', 'paddleocr', 'generic', 'mock'] as const

const AUTH_MODES = ['none', 'header', 'query', 'token-exchange'] as const
const ENCODINGS = ['json', 'form', 'raw'] as const
const IMAGE_MODES = ['base64', 'url'] as const

/** 卡片可编辑的供应商字段（secret 字段只写）。 */
const PROVIDER_FIELDS = [
  { key: 'endpoint', secret: false },
  { key: 'auth', secret: false },
  { key: 'apiKey', secret: true },
  { key: 'secretKey', secret: true },
  { key: 'tokenEndpoint', secret: false },
  { key: 'headerName', secret: false },
  { key: 'queryParam', secret: false },
  { key: 'encoding', secret: false },
  { key: 'imageMode', secret: false },
  { key: 'template', secret: false },
  { key: 'textPath', secret: false },
  { key: 'confidencePath', secret: false },
  { key: 'join', secret: false },
] as const

// ── i18n ────────────────────────────────────────────────────────────────────

const zh = {
  title: 'OCR 图片文字识别',
  description: '第三方 OCR 接入：ocr 工具默认全局可用，供应商纯配置接入（内置百度智能云 / PaddleOCR / 通用 REST 预设）。',
  enabled: '启用 OCR',
  enabledHint: '插件总开关；关闭后 ocr 工具不可用',
  toolEnabled: '注册 ocr 工具',
  toolEnabledHint: '让 agent 可直接调用 ocr 识别图片（全局默认开启）',
  defaultProvider: '默认供应商',
  defaultProviderHint: '调用未指定 provider 时使用',
  timeoutMs: '超时（毫秒）',
  maxImageBytes: '图片字节上限',
  providersTitle: '供应商配置',
  providerId: '供应商 id',
  providerIdHint: '内置预设：baidu / paddleocr / generic / mock；也可自定义新 id',
  endpoint: 'API 端点',
  auth: '鉴权模式',
  apiKey: 'API Key',
  apiKeyHint: '写only：留空不修改',
  secretKey: 'Secret Key',
  tokenEndpoint: 'Token 换发端点',
  headerName: 'Header 名',
  queryParam: 'Query 参数名',
  encoding: '请求体编码',
  imageMode: '图片嵌入方式',
  template: '请求体模板',
  templateHint: '占位符 ${image_base64} / ${image_url} / ${lang|默认值}',
  textPath: '文本路径（简化 JSONPath）',
  confidencePath: '置信度路径',
  join: '拼接符',
  configured: '已配置',
  notConfigured: '未配置',
  save: '保存',
  saving: '保存中…',
  saveFailed: '保存失败，请重试',
  delete: '删除',
  deleting: '删除中…',
  deleteConfirm: '删除该供应商的用户配置？',
  unavailable: '设置不可用（host 未挂载设置服务）',
  clear: '留空保存 = 清除该字段（回落预设/默认值）',
} as const

const en = {
  title: 'OCR',
  description: 'Third-party OCR: the ocr tool is globally available by default; providers are configuration-only (Baicould / PaddleOCR / generic REST presets built in).',
  enabled: 'Enable OCR',
  enabledHint: 'Master switch; the ocr tool is unavailable when off',
  toolEnabled: 'Register the ocr tool',
  toolEnabledHint: 'Lets the agent call ocr on images (on by default)',
  defaultProvider: 'Default provider',
  defaultProviderHint: 'Used when a call does not name a provider',
  timeoutMs: 'Timeout (ms)',
  maxImageBytes: 'Max image bytes',
  providersTitle: 'Providers',
  providerId: 'Provider id',
  providerIdHint: 'Presets: baidu / paddleocr / generic / mock; or a custom id',
  endpoint: 'API endpoint',
  auth: 'Auth mode',
  apiKey: 'API key',
  apiKeyHint: 'Write-only: leave blank to keep',
  secretKey: 'Secret key',
  tokenEndpoint: 'Token endpoint',
  headerName: 'Header name',
  queryParam: 'Query param name',
  encoding: 'Body encoding',
  imageMode: 'Image mode',
  template: 'Request template',
  templateHint: 'Placeholders ${image_base64} / ${image_url} / ${lang|default}',
  textPath: 'Text path (JSONPath subset)',
  confidencePath: 'Confidence path',
  join: 'Join string',
  configured: 'configured',
  notConfigured: 'not configured',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'Save failed, retry',
  delete: 'Delete',
  deleting: 'Deleting…',
  deleteConfirm: 'Delete this provider’s user configuration?',
  unavailable: 'Settings unavailable (no settings service on host)',
  clear: 'Blank + save = clear the field (falls back to preset/default)',
} as const

// ── styles ──────────────────────────────────────────────────────────────────

const css = `.OcrS_card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-specific-tip);padding:12px}
.OcrS_title{font:var(--dsw-font-xs-13);font-family:Inter,var(--dsw-font-family);color:var(--dsw-alias-label-primary);font-weight:600;line-height:20px;margin:0}
.OcrS_desc{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px}
.OcrS_group{margin-top:10px;display:flex;flex-direction:column;gap:6px}
.OcrS_groupTitle{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;line-height:16px;letter-spacing:.04em;text-transform:uppercase}
.OcrS_row{align-items:center;justify-content:space-between;gap:12px;display:flex}
.OcrS_rowLabel{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
.OcrS_label{color:var(--dsw-alias-label-primary);font-size:12px;line-height:16px}
.OcrS_hint{color:var(--dsw-alias-label-caption);font-size:11px;line-height:14px}
.OcrS_control{flex:none;width:200px;box-sizing:border-box;display:flex;flex-direction:column;gap:2px;align-items:flex-end}
.OcrS_input{width:100%;height:26px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-interactive-bg);color:var(--dsw-alias-label-primary);font-size:12px;padding:0 8px;outline:none}
.OcrS_input:focus{border-color:var(--dsw-alias-interactive-accent)}
.OcrS_select{width:100%;height:26px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-interactive-bg);color:var(--dsw-alias-label-primary);font-size:12px;padding:0 6px;outline:none}
.OcrS_textarea{width:100%;min-height:52px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-interactive-bg);color:var(--dsw-alias-label-primary);font-size:12px;line-height:16px;padding:6px 8px;outline:none;resize:vertical;font-family:monospace}
.OcrS_switch{position:relative;width:32px;height:18px;flex:none;cursor:pointer;background:var(--dsw-alias-interactive-bg);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;outline:none;padding:0;transition:background .15s}
.OcrS_switch[aria-checked="true"]{background:var(--dsw-alias-interactive-accent);border-color:transparent}
.OcrS_knob{position:absolute;top:1px;left:1px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s}
.OcrS_switch[aria-checked="true"] .OcrS_knob{transform:translateX(14px)}
.OcrS_badge{flex:none;height:18px;border-radius:9px;padding:0 8px;font-size:10px;line-height:18px}
.OcrS_badgeOn{background:var(--dsw-alias-interactive-accent);color:#fff}
.OcrS_badgeOff{background:var(--dsw-alias-interactive-bg);color:var(--dsw-alias-label-caption)}
.OcrS_actions{margin-top:10px;justify-content:flex-end;gap:6px;display:flex}
.OcrS_btn{height:26px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;outline:none;align-items:center;gap:4px;padding:0 12px;font-size:12px;font-weight:500;line-height:16px;display:inline-flex}
.OcrS_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.OcrS_btn:disabled{cursor:default;opacity:.5}
.OcrS_btnPrimary{color:#fff;background:var(--dsw-alias-interactive-accent);border-color:transparent}
.OcrS_btnPrimary:hover:not(:disabled){background:var(--dsw-alias-interactive-accent)}
.OcrS_btnDanger{color:var(--dsw-alias-state-business-danger, #d0453a)}
.OcrS_btnDanger:hover:not(:disabled){background:var(--dsw-alias-state-business-danger-bg, rgba(208,69,58,.1))}
.OcrS_error{margin-top:8px;color:var(--dsw-alias-state-business-danger, #d0453a);font-size:12px;line-height:16px}`

const cssTagId = '@dsh-external/dsh-ocr/OcrSettingsCard.module.css'
if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${cssTagId}"]`) === null) {
  const tag = document.createElement('style')
  tag.dataset.plugin = '@dsh-external/dsh-ocr'
  tag.dataset.pluginCss = cssTagId
  tag.textContent = css
  document.head.appendChild(tag)
}

// ── 状态面 ──────────────────────────────────────────────────────────────────

interface OcrCardState {
  status: 'loading' | 'ready' | 'unavailable'
  writable: boolean
  value: Record<string, any> | null
  user: Record<string, any> | null
  revision: number | undefined
  saving: boolean
  failed: boolean
}

function createStore<T>(get: () => T): { getSnapshot: () => T; subscribe: (l: () => void) => () => void; emit: () => void } {
  let snapshot = get()
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit: () => {
      snapshot = get()
      for (const listener of listeners) listener()
    },
  }
}

// ── 卡片组件 ────────────────────────────────────────────────────────────────

interface OcrSettingsCardProps {
  t: any
  useOcrCard: (selector: (state: OcrCardState) => any) => any
  setField: (field: string, value: unknown) => Promise<void>
  unsetField: (field: string) => Promise<void>
  saveProvider: (id: string, fields: Record<string, string>) => Promise<boolean>
  deleteProvider: (id: string) => Promise<boolean>
}

function OcrSettingsCard({ t, useOcrCard, setField, unsetField, saveProvider, deleteProvider }: OcrSettingsCardProps): ReactNode {
  const state = useOcrCard((s: OcrCardState) => s)
  const [providerId, setProviderId] = useState('')
  const [draft, setDraft] = useState<Record<string, string>>({})

  const value = state.value
  const user = state.user
  const disabled = !state.writable

  // 供应商候选：预设 + 已配置 id
  const providerIds = useMemo(() => {
    const ids = new Set<string>(PRESET_IDS)
    for (const id of Object.keys(value?.providers ?? {})) ids.add(id)
    return [...ids].sort()
  }, [value])

  const activeId = providerId !== '' && providerIds.includes(providerId) ? providerId : providerIds[0] ?? ''

  // 切换供应商时，把当前值种入草稿（secret 字段留空）
  const selectProvider = useCallback((id: string): void => {
    setProviderId(id)
    const entry = value?.providers?.[id] as Record<string, any> | undefined
    const next: Record<string, string> = {}
    for (const field of PROVIDER_FIELDS) {
      if (field.secret) {
        next[field.key] = ''
        continue
      }
      const raw = entry?.[field.key]
      next[field.key] = raw === undefined || raw === null ? '' : String(raw)
    }
    setDraft(next)
  }, [value])

  // 草稿在 providerId 首次生效或供应商集合变化时种入
  const seeded = useRef<string | null>(null)
  useEffect(() => {
    if (seeded.current === activeId) return
    seeded.current = activeId
    if (activeId !== '') selectProvider(activeId)
  }, [activeId, selectProvider])

  const setDraftField = useCallback((key: string, text: string): void => {
    setDraft((previous) => ({ ...previous, [key]: text }))
  }, [])

  if (state.status === 'unavailable') {
    return (
      <section className="OcrS_card">
        <h3 className="OcrS_title">{t('title')}</h3>
        <p className="OcrS_desc">{t('unavailable')}</p>
      </section>
    )
  }
  if (state.status !== 'ready' || value === null) return null

  const hasConfigured = (key: string): boolean => {
    const entry = user?.providers?.[activeId] as Record<string, any> | undefined
    return entry?.[key] !== undefined
  }

  const onSaveProvider = async (): Promise<void> => {
    const ok = await saveProvider(activeId, draft)
    if (ok) {
      // secret 草稿在成功后清空，防止重复提交
      setDraft((previous) => ({ ...previous, apiKey: '', secretKey: '' }))
    }
  }

  const onDeleteProvider = async (): Promise<void> => {
    if (!window.confirm(t('deleteConfirm'))) return
    const ok = await deleteProvider(activeId)
    if (ok) {
      seeded.current = null
      const remaining = providerIds.filter((id) => id !== activeId)
      setProviderId(remaining[0] ?? '')
    }
  }

  const numberCommit = (field: string, text: string): void => {
    const trimmed = text.trim()
    if (trimmed === '') {
      void unsetField(field)
      return
    }
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) return
    void setField(field, parsed)
  }

  return (
    <section className="OcrS_card" aria-label={t('title')}>
      <h3 className="OcrS_title">{t('title')}</h3>
      <p className="OcrS_desc">{t('description')}</p>

      <div className="OcrS_group">
        <div className="OcrS_row">
          <span className="OcrS_rowLabel">
            <span className="OcrS_label">{t('enabled')}</span>
            <span className="OcrS_hint">{t('enabledHint')}</span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={value.enabled === true}
            className="OcrS_switch"
            disabled={disabled}
            onClick={() => void setField('enabled', value.enabled !== true)}
          >
            <span className="OcrS_knob" />
          </button>
        </div>
        <div className="OcrS_row">
          <span className="OcrS_rowLabel">
            <span className="OcrS_label">{t('toolEnabled')}</span>
            <span className="OcrS_hint">{t('toolEnabledHint')}</span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={value.toolEnabled === true}
            className="OcrS_switch"
            disabled={disabled}
            onClick={() => void setField('toolEnabled', value.toolEnabled !== true)}
          >
            <span className="OcrS_knob" />
          </button>
        </div>
      </div>

      <div className="OcrS_group">
        <div className="OcrS_groupTitle">{t('defaultProvider')}</div>
        <div className="OcrS_row">
          <span className="OcrS_hint">{t('defaultProviderHint')}</span>
          <span className="OcrS_control">
            <select
              className="OcrS_select"
              value={value.defaultProvider ?? 'mock'}
              disabled={disabled}
              onChange={(e) => void setField('defaultProvider', e.target.value)}
            >
              {providerIds.map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
          </span>
        </div>
        <div className="OcrS_row">
          <span className="OcrS_label">{t('timeoutMs')}</span>
          <span className="OcrS_control">
            <input
              className="OcrS_input"
              type="number"
              min={1000}
              defaultValue={value.timeoutMs ?? 30000}
              key={`timeout-${value.timeoutMs ?? 30000}`}
              disabled={disabled}
              onBlur={(e) => numberCommit('timeoutMs', e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') numberCommit('timeoutMs', (e.target as HTMLInputElement).value)
              }}
            />
          </span>
        </div>
        <div className="OcrS_row">
          <span className="OcrS_label">{t('maxImageBytes')}</span>
          <span className="OcrS_control">
            <input
              className="OcrS_input"
              type="number"
              min={1024}
              defaultValue={value.maxImageBytes ?? 20971520}
              key={`max-${value.maxImageBytes ?? 20971520}`}
              disabled={disabled}
              onBlur={(e) => numberCommit('maxImageBytes', e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') numberCommit('maxImageBytes', (e.target as HTMLInputElement).value)
              }}
            />
          </span>
        </div>
      </div>

      <div className="OcrS_group">
        <div className="OcrS_groupTitle">{t('providersTitle')}</div>
        <div className="OcrS_row">
          <span className="OcrS_rowLabel">
            <span className="OcrS_label">{t('providerId')}</span>
            <span className="OcrS_hint">{t('providerIdHint')}</span>
          </span>
          <span className="OcrS_control">
            <input
              className="OcrS_input"
              list="ocr-provider-ids"
              value={activeId}
              disabled={disabled}
              onChange={(e) => selectProvider(e.target.value.trim())}
            />
            <datalist id="ocr-provider-ids">
              {providerIds.map((id) => <option key={id} value={id} />)}
            </datalist>
          </span>
        </div>

        {PROVIDER_FIELDS.map((field) => {
          const fieldValue = draft[field.key] ?? ''
          const label = t(field.key === 'apiKey' ? 'apiKey' : field.key)
          const secretBadge = field.secret ? (
            <span className={`OcrS_badge ${hasConfigured(field.key) ? 'OcrS_badgeOn' : 'OcrS_badgeOff'}`}>
              {hasConfigured(field.key) ? t('configured') : t('notConfigured')}
            </span>
          ) : null
          let control: ReactNode
          if (field.key === 'auth' || field.key === 'encoding' || field.key === 'imageMode') {
            const options = field.key === 'auth' ? AUTH_MODES : field.key === 'encoding' ? ENCODINGS : IMAGE_MODES
            control = (
              <select
                className="OcrS_select"
                value={fieldValue}
                disabled={disabled}
                onChange={(e) => setDraftField(field.key, e.target.value)}
              >
                {options.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            )
          } else if (field.key === 'template') {
            control = (
              <textarea
                className="OcrS_textarea"
                value={fieldValue}
                disabled={disabled}
                placeholder={t('templateHint')}
                onChange={(e) => setDraftField(field.key, e.target.value)}
              />
            )
          } else {
            control = (
              <input
                className="OcrS_input"
                type={field.secret ? 'password' : 'text'}
                value={fieldValue}
                disabled={disabled}
                placeholder={field.secret ? t('apiKeyHint') : undefined}
                autoComplete="off"
                onChange={(e) => setDraftField(field.key, e.target.value)}
              />
            )
          }
          return (
            <div className="OcrS_row" key={field.key}>
              <span className="OcrS_rowLabel">
                <span className="OcrS_label">{label}</span>
                {(field.key === 'template' || field.key === 'apiKey' || field.key === 'secretKey') && (
                  <span className="OcrS_hint">{t(field.key === 'template' ? 'templateHint' : 'apiKeyHint')}</span>
                )}
              </span>
              <span className="OcrS_control">
                {control}
                {secretBadge}
              </span>
            </div>
          )
        })}

        <p className="OcrS_hint">{t('clear')}</p>
        <div className="OcrS_actions">
          <button
            type="button"
            className="OcrS_btn OcrS_btnDanger"
            disabled={disabled || state.saving || Object.keys(user?.providers?.[activeId] ?? {}).length === 0}
            onClick={() => void onDeleteProvider()}
          >
            {state.saving ? t('deleting') : t('delete')}
          </button>
          <button
            type="button"
            className="OcrS_btn OcrS_btnPrimary"
            disabled={disabled || state.saving || activeId === ''}
            onClick={() => void onSaveProvider()}
          >
            {state.saving ? t('saving') : t('save')}
          </button>
        </div>
        {state.failed && <div className="OcrS_error">{t('saveFailed')}</div>}
      </div>
    </section>
  )
}

// ── 插件体 ──────────────────────────────────────────────────────────────────

interface ClientContext extends Context {
  slots: SlotRegistry
  locale: {
    register(namespace: string, dict: Record<string, unknown>): unknown
  }
  settingsScope: {
    bind(spec: { namespace: string }): {
      getSnapshot(): any
      subscribe(listener: () => void): () => void
      set(field: string, value: unknown): Promise<void>
      unset(field: string): Promise<void>
    }
  }
  get(service: 'connection'): { api: { settings: { mutate(input: any): Promise<any> } } }
}

export const inject = ['slots', 'locale', 'connection', 'settingsScope']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    ctx.locale.register(NS, { zh, en })
    return () => {}
  }, '@dsh-external/dsh-ocr: dictionaries')

  const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS })
  const { api } = ctx.get('connection')

  let saving = false
  let failed = false

  const store = createStore<OcrCardState>(() => {
    const snapshot = scope.getSnapshot()
    return {
      status: snapshot.status,
      writable: snapshot.writable,
      value: snapshot.value ?? null,
      user: snapshot.user ?? null,
      revision: snapshot.revision,
      saving,
      failed,
    }
  })
  const offScope = scope.subscribe(() => store.emit())
  ctx.effect(() => () => offScope(), '@dsh-external/dsh-ocr: settings subscription')

  const withSaveFlag = async <T,>(run: () => Promise<T>): Promise<T> => {
    saving = true
    failed = false
    store.emit()
    try {
      const result = await run()
      failed = false
      return result
    } catch {
      failed = true
      throw new Error('save failed')
    } finally {
      saving = false
      store.emit()
    }
  }

  const face = {
    hooks: { ocrCard: store },
    setField: (field: string, value: unknown) => withSaveFlag(() => scope.set(field, value)).then(() => {}, () => {}),
    unsetField: (field: string) => withSaveFlag(() => scope.unset(field)).then(() => {}, () => {}),
    saveProvider: async (id: string, fields: Record<string, string>): Promise<boolean> => {
      try {
        await withSaveFlag(async () => {
          const revision = scope.getSnapshot().revision
          const ops: unknown[] = []
          for (const field of PROVIDER_FIELDS) {
            const text = fields[field.key] ?? ''
            if (field.secret) {
              if (text === '') continue
              ops.push({ op: 'set', path: ['providers', id, field.key], value: text })
              continue
            }
            if (text === '') ops.push({ op: 'unset', path: ['providers', id, field.key] })
            else ops.push({ op: 'set', path: ['providers', id, field.key], value: text })
          }
          if (ops.length === 0) return
          const response = await api.settings.mutate({
            ns: SETTINGS_NS,
            ops,
            ...(revision === undefined ? {} : { expectedRevision: revision }),
          })
          if (response?.result?.ok !== true) throw new Error('settings write refused')
        })
        return true
      } catch {
        return false
      }
    },
    deleteProvider: async (id: string): Promise<boolean> => {
      try {
        await withSaveFlag(async () => {
          const revision = scope.getSnapshot().revision
          const response = await api.settings.mutate({
            ns: SETTINGS_NS,
            ops: [{ op: 'unset', path: ['providers', id] }],
            ...(revision === undefined ? {} : { expectedRevision: revision }),
          })
          if (response?.result?.ok !== true) throw new Error('settings write refused')
        })
        return true
      } catch {
        return false
      }
    },
  }

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    id: 'dsh-ocr',
    order: 30,
    locale: NS as unknown as 'settings.plugins',
    inject: () => face,
  }, OcrSettingsCard))
}

export { OcrSettingsCard }
