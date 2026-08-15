/**
 * @dsh-external/dsh-ocr — host half.
 *
 * 外置第三方 OCR：
 * - 注册模型可调用的 `ocr` 工具（defineTool + systemPrompt 指引），默认全局
 *   开启，可在设置面板关闭（enabled / toolEnabled）。
 * - 通过 `installSettingsSection` 把插件 Config 注册成 settings 命名空间
 *   `dsh-ocr`：设置面板（settings.plugin.item 卡片）实时读写，改动即时生效，
 *   apiKey / secretKey 以 role('secret') 标记，字面值永不下发浏览器。
 * - provider 层见 ./engine.ts：通用 REST 适配器 + 预设（baidu /
 *   paddleocr / generic / mock），绝大多数第三方 OCR 服务纯配置接入。
 */
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
import {
  DEFAULT_FIELDS,
  PRESETS,
  type ProviderConfig,
  recognize,
  resolveProvider,
} from './engine.js'

export const name = '@dsh-external/dsh-ocr'
export const inject = ['tools', 'systemPrompt']

/** Settings 命名空间（client 卡片同名字符串，两侧各自拼写）。 */
export const OCR_SETTINGS_NAMESPACE = 'dsh-ocr'

const ProviderSchema = z.object({
  endpoint: z.string().default(''),
  auth: z.union([z.const('none'), z.const('header'), z.const('query'), z.const('token-exchange')]).default('none'),
  apiKey: z.string().role('secret').default(''),
  secretKey: z.string().role('secret').default(''),
  headerName: z.string().default('Authorization'),
  queryParam: z.string().default('access_token'),
  tokenEndpoint: z.string().default(''),
  encoding: z.union([z.const('json'), z.const('form'), z.const('raw')]).default('json'),
  template: z.string().default(''),
  imageMode: z.union([z.const('base64'), z.const('url')]).default('base64'),
  textPath: z.string().default(''),
  confidencePath: z.string().default(''),
  join: z.string().default('\n'),
})

export interface Config {
  /** 插件总开关。 */
  enabled: boolean
  /** 注册 agent 侧 `ocr` 工具（默认全局开启）。 */
  toolEnabled: boolean
  /** agent 调用未指定 provider 时使用的供应商 id。 */
  defaultProvider: string
  /** 单次识别的协作超时预算（ms）。 */
  timeoutMs: number
  /** 图片字节上限（data URL / URL / 本地文件统一约束）。 */
  maxImageBytes: number
  /** 供应商配置表：id → ProviderConfig（逐字段覆盖同 id 预设）。 */
  providers: Record<string, ProviderConfig>
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  toolEnabled: z.boolean().default(true),
  defaultProvider: z.string().default('mock'),
  timeoutMs: z.number().min(1000).default(30000),
  maxImageBytes: z.number().min(1024).default(20 * 1024 * 1024),
  providers: z.dict(ProviderSchema).default({}),
})

/** 内置预设 id（设置面板下拉可选项，与 engine.PRESETS 保持一致）。 */
export const PRESET_IDS = Object.keys(PRESETS)

/** 当前生效配置（settings 挂载后实时跟随，未挂载时回落 entry config）。 */
function providerList(config: Config): { defaultProvider: string; providers: string[] } {
  const ids = new Set<string>([...PRESET_IDS, ...Object.keys(config.providers ?? {})])
  return { defaultProvider: config.defaultProvider, providers: [...ids].sort() }
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let disposeTool: (() => void) | undefined
  let disposePrompt: (() => void) | undefined

  const rebuild = (): void => {
    disposeTool?.()
    disposePrompt?.()
    disposeTool = undefined
    disposePrompt = undefined
    const resolved = current()
    if (!resolved.enabled || !resolved.toolEnabled) return

    disposePrompt = ctx.systemPrompt.section({
      name: 'tool:ocr',
      order: 112,
      text: 'Use the ocr tool to extract readable text from images (screenshots, photos of documents, UI, tables, or scans) when you need to read their content. Prefer it over guessing from an image you cannot see.',
    })

    const list = providerList(resolved)
    disposeTool = ctx.tools.register(defineTool({
      name: 'ocr',
      description:
        'Extract text from an image via a configured third-party OCR provider. ' +
        'The image argument accepts an absolute path or a path relative to the workspace root, ' +
        'an http(s) URL, or a data: URL with base64 content.',
      parameters: {
        image: {
          type: 'string',
          required: true,
          description:
            'The image to recognize: an absolute path or workspace-relative path to an image file, an http(s) URL, or a data: URL (data:...;base64,...).',
        },
        provider: {
          type: 'string',
          description:
            `OCR provider id to use; omit to use the default "${list.defaultProvider}". ` +
            `Available: ${list.providers.join(', ')}.`,
        },
        lang: {
          type: 'string',
          description:
            'Optional language hint for the provider (e.g. CHN_ENG for Chinese+English on Baidu, eng for English). Providers that ignore it do so silently.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            confidence: { type: 'number' },
            provider: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
        presentationMeta: (_args, value) => ({
          provider: value.provider,
          textLength: value.text.length,
        }),
      },
      timeoutMs: resolved.timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const active = current()
        const providerId = args.provider !== undefined && args.provider !== '' ? args.provider : active.defaultProvider
        const configForProvider = resolveProvider(providerId, active.providers?.[providerId])
        const result = await recognize(providerId, configForProvider, args.image, args.lang, {
          maxBytes: active.maxImageBytes,
          timeoutMs: active.timeoutMs,
          signal: exec.signal,
        })
        return {
          text: result.text,
          ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
          provider: result.provider,
        }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'OCR',
        kind: 'other',
        rawInput: typeof args.image === 'string' ? args.image : undefined,
      }),
    }))
  }

  installSettingsSection(ctx, settingsNamespace(OCR_SETTINGS_NAMESPACE), Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: rebuild,
  })
  rebuild()

  ctx.logger?.info?.(`[${name}] ocr ready: tool=${current().enabled && current().toolEnabled} default=${current().defaultProvider}`)
}
