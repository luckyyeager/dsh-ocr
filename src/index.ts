/**
 * @dsh-external/dsh-ocr — host half.
 *
 * 外置第三方 OCR：
 * - 注册模型可调用的 `ocr` 工具（defineTool + systemPrompt 指引），默认全局
 *   开启，可在设置面板关闭（enabled / toolEnabled）。
 * - 通过 `installSettingsSection` 把插件 Config 注册成 settings 命名空间
 *   `dsh-ocr`，改动即时生效；apiKey / secretKey 以 role('secret') 标记。
 * - 设置面板数据桥（GET/POST /api/ocr/settings）：apiproxy 的 Web 客户端
 *   命名空间白名单不含本插件（插件自暴露是官方 deferred work），外置插件
 *   无法改白名单，故卡片经此同源桥读写——服务端直读直写 settings 命名空间
 *   （服务端不受白名单门禁），GET 返回 redacted 视图，密钥字面值永不下发。
 * - provider 层见 ./engine.ts：通用 REST 适配器 + 预设（baidu /
 *   paddleocr / generic / mock），绝大多数第三方 OCR 服务纯配置接入。
 */
import type { Context } from 'cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installSettingsSection, SettingsConflictError, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
import {
  DEFAULT_FIELDS,
  PRESETS,
  type ProviderConfig,
  recognize,
  resolveProvider,
} from './engine.js'

export const name = '@dsh-external/dsh-ocr'
export const inject = ['tools', 'systemPrompt', 'webServer']

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

  // ── 设置面板数据桥（同源 API，服务端直读直写 settings 命名空间） ─────────
  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.statusCode = code
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(body))
  }

  const readJsonBody = (req: IncomingMessage, maxBytes: number): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) {
          reject(new Error('request body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
      req.on('error', reject)
    })

  /** redacted 命名空间视图；未挂载/未注册时 status 非 ready。 */
  const namespaceView = (): Record<string, unknown> => {
    const settings = ctx.get('settings')
    if (settings === undefined) return { status: 'unavailable' }
    const descriptor = settings
      .describe({ redactSecrets: true })
      .find((entry) => String(entry.ns) === OCR_SETTINGS_NAMESPACE)
    if (descriptor === undefined) return { status: 'unavailable' }
    return {
      status: 'ready',
      ns: OCR_SETTINGS_NAMESPACE,
      value: descriptor.value,
      base: descriptor.base,
      user: descriptor.user,
      applies: descriptor.applies,
      revision: descriptor.revision,
      writable: true,
      secrets: (descriptor.secrets ?? []).map((secret) => ({ path: [...secret.path], set: secret.set })),
    }
  }

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'exact',
      path: '/api/ocr/settings',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method === 'GET') {
          return json(res, 200, namespaceView())
        }
        if (req.method === 'POST') {
          const settings = ctx.get('settings')
          if (settings === undefined) return json(res, 503, { ok: false, code: 'unavailable', message: 'settings service not mounted' })
          let body: Record<string, unknown>
          try {
            body = (await readJsonBody(req, 512 * 1024)) as Record<string, unknown>
          } catch (error) {
            return json(res, 400, { ok: false, code: 'bad-body', message: error instanceof Error ? error.message : String(error) })
          }
          const ops = body.ops
          if (!Array.isArray(ops) || ops.length === 0 || ops.length > 64) {
            return json(res, 400, { ok: false, code: 'bad-ops', message: 'ops must be a non-empty array of at most 64 path edits' })
          }
          for (const op of ops as Array<Record<string, unknown>>) {
            if (op.op !== 'set' && op.op !== 'unset') return json(res, 400, { ok: false, code: 'bad-ops', message: 'op must be set or unset' })
            if (!Array.isArray(op.path) || op.path.length === 0 || !op.path.every((segment) => typeof segment === 'string')) {
              return json(res, 400, { ok: false, code: 'bad-ops', message: 'op.path must be a non-empty string array' })
            }
            if (op.op === 'set' && op.value === undefined) {
              return json(res, 400, { ok: false, code: 'bad-ops', message: 'set op requires a value' })
            }
          }
          const expectedRevision = typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined
          try {
            await settings.mutate(
              settingsNamespace(OCR_SETTINGS_NAMESPACE),
              ops as never,
              expectedRevision,
            )
          } catch (error) {
            if (error instanceof SettingsConflictError) {
              return json(res, 409, { ok: false, code: 'conflict', message: error.message, ...namespaceView() })
            }
            return json(res, 400, { ok: false, code: 'rejected', message: error instanceof Error ? error.message : String(error) })
          }
          return json(res, 200, { ok: true, ...namespaceView() })
        }
        res.setHeader('Allow', 'GET, POST')
        return json(res, 405, { ok: false, code: 'method', message: 'GET or POST only' })
      },
    })
    return disposeRoute
  }, '@dsh-external/dsh-ocr: settings bridge')

  ctx.logger?.info?.(`[${name}] ocr ready: tool=${current().enabled && current().toolEnabled} default=${current().defaultProvider}`)
}
