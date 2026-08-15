/**
 * @dsh-external/dsh-ocr — host half.
 *
 * 外置第三方 OCR：
 * - 注册模型可调用的 `ocr` 工具（defineTool + systemPrompt 指引），
 *   让 agent 直接识别截图 / 照片 / 文档扫描件。
 * - 注册面板 API（GET /api/ocr/providers、POST /api/ocr/recognize，
 *   webServer 精确路由），密钥只在 host 侧，永不下发浏览器。
 * - provider 层见 ./engine.ts：通用 REST 适配器 + 预设（baidu /
 *   paddleocr / generic / mock），绝大多数第三方 OCR 服务纯配置接入。
 */
import type { Context } from 'cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
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

export interface Config {
  /** 插件总开关。 */
  enabled: boolean
  /** 注册 agent 侧 `ocr` 工具。 */
  toolEnabled: boolean
  /** 注册 Web GUI 面板 API 路由。 */
  panelEnabled: boolean
  /** agent 调用未指定 provider 时使用的供应商 id。 */
  defaultProvider: string
  /** 单次识别的协作超时预算（ms）。 */
  timeoutMs: number
  /** 图片字节上限（data URL / URL / 本地文件统一约束）。 */
  maxImageBytes: number
  /** 供应商配置表：id → ProviderConfig（逐字段覆盖同 id 预设）。 */
  providers: Record<string, Partial<ProviderConfig>>
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  toolEnabled: z.boolean().default(true),
  panelEnabled: z.boolean().default(true),
  defaultProvider: z.string().default('mock'),
  timeoutMs: z.number().min(1000).default(30000),
  maxImageBytes: z.number().min(1024).default(20 * 1024 * 1024),
  providers: z.dict(z.any()).default({}),
})

/** 面板/工具可见的供应商清单（不含任何密钥）。 */
function providerList(config: Config): { defaultProvider: string; providers: string[] } {
  const ids = new Set<string>([...Object.keys(PRESETS), ...Object.keys(config.providers ?? {})])
  return { defaultProvider: config.defaultProvider, providers: [...ids].sort() }
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

/** 读取并解析请求体（带上限）。 */
function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
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
}

export function apply(ctx: Context, config: Config): void {
  const resolved: Config = config
  if (!resolved.enabled) return

  const resolve = (id: string): ProviderConfig =>
    resolveProvider(id, resolved.providers?.[id] as Partial<ProviderConfig> | undefined)

  // ── agent 侧：ocr 工具 ────────────────────────────────────────────────
  if (resolved.toolEnabled) {
    ctx.systemPrompt.section({
      name: 'tool:ocr',
      order: 112,
      text: 'Use the ocr tool to extract readable text from images (screenshots, photos of documents, UI, tables, or scans) when you need to read their content. Prefer it over guessing from an image you cannot see.',
    })

    const list = providerList(resolved)
    ctx.tools.register(defineTool({
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
        const providerId = args.provider !== undefined && args.provider !== '' ? args.provider : resolved.defaultProvider
        const configForProvider = resolve(providerId)
        const result = await recognize(providerId, configForProvider, args.image, args.lang, {
          maxBytes: resolved.maxImageBytes,
          timeoutMs: resolved.timeoutMs,
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

  // ── 面板侧：API 路由（密钥不进浏览器） ───────────────────────────────
  if (resolved.panelEnabled) {
    ctx.effect(() => {
      const disposeProviders = ctx.webServer.register({
        kind: 'exact',
        path: '/api/ocr/providers',
        handler: (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'GET') {
            res.setHeader('Allow', 'GET')
            return json(res, 405, { ok: false, code: 'method', message: 'GET only' })
          }
          return json(res, 200, {
            ok: true,
            ...providerList(resolved),
            // 全局视图可见性探针：新会话的 tools schema 是否包含 ocr。
            toolRegistered: ctx.tools.get('ocr') !== undefined,
          })
        },
      })
      const disposeRecognize = ctx.webServer.register({
        kind: 'exact',
        path: '/api/ocr/recognize',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            res.setHeader('Allow', 'POST')
            return json(res, 405, { ok: false, code: 'method', message: 'POST only' })
          }
          let body: Record<string, unknown>
          try {
            body = (await readJsonBody(req, resolved.maxImageBytes * 2)) as Record<string, unknown>
          } catch (error) {
            return json(res, 400, { ok: false, code: 'bad-body', message: error instanceof Error ? error.message : String(error) })
          }
          const image = body.image
          if (typeof image !== 'string' || image === '') {
            return json(res, 400, { ok: false, code: 'bad-image', message: 'image must be a non-empty string' })
          }
          const providerId = typeof body.provider === 'string' && body.provider !== '' ? body.provider : resolved.defaultProvider
          const lang = typeof body.lang === 'string' && body.lang !== '' ? body.lang : undefined
          try {
            const result = await recognize(providerId, resolve(providerId), image, lang, {
              maxBytes: resolved.maxImageBytes,
              timeoutMs: resolved.timeoutMs,
              signal: undefined,
            })
            return json(res, 200, { ok: true, ...result })
          } catch (error) {
            return json(res, 502, {
              ok: false,
              code: 'recognize-failed',
              message: error instanceof Error ? error.message : String(error),
            })
          }
        },
      })
      return () => {
        disposeProviders()
        disposeRecognize()
      }
    }, '@dsh-external/dsh-ocr: panel api')
  }

  ctx.logger?.info?.(
    `[${name}] ocr ready: tool=${resolved.toolEnabled} panel=${resolved.panelEnabled} default=${resolved.defaultProvider}`,
  )
}
