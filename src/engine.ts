/**
 * @dsh-external/dsh-ocr — provider engine.
 *
 * 通用第三方 OCR 接入引擎：一份 ProviderConfig 描述一个供应商的
 * HTTP 契约（鉴权 / 请求体编码 / 响应字段路径），绝大多数第三方
 * OCR 服务（云厂商、私有化部署、本地开源服务）都能纯配置接入，
 * 无需改代码。内置预设（baidu / paddleocr / generic / mock）只
 * 是一组默认字段，用户配置可逐字段覆盖。
 */
import { readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, join } from 'node:path'

/** 鉴权模式。 */
export type AuthMode = 'none' | 'header' | 'query' | 'token-exchange'
/** 请求体编码。 */
export type BodyEncoding = 'json' | 'form' | 'raw'
/** 图片嵌入方式。 */
export type ImageMode = 'base64' | 'url'

export interface ProviderConfig {
  /** OCR API 端点（含协议）。空端点仅 mock 预设可用。 */
  endpoint: string
  /** 鉴权模式：无 / 请求头 / 查询参数 / 先用 apiKey+secretKey 换 token 再挂查询参数。 */
  auth: AuthMode
  /** API Key；token-exchange 模式下作为 client_id。 */
  apiKey: string
  /** Secret Key；token-exchange 模式下作为 client_secret。 */
  secretKey: string
  /** header 模式的请求头名。 */
  headerName: string
  /** query 模式携带 apiKey、token-exchange 模式携带 access_token 的查询参数名。 */
  queryParam: string
  /** token-exchange 模式的换发端点。 */
  tokenEndpoint: string
  /** 请求体编码。 */
  encoding: BodyEncoding
  /**
   * 请求体模板。占位符：
   * - ${image_base64}：图片 base64（json/form 中直接替换为字符串）
   * - ${image_url}：图片公开 URL（imageMode: url 时）
   * - ${lang}：语言提示（可选默认值写法 ${lang|CHN_ENG}）
   * 空模板按 encoding 用默认体（json: {"image": "..."}；form: image=...）。
   */
  template: string
  /** 图片以 base64 还是 URL 形式嵌入请求。 */
  imageMode: ImageMode
  /**
   * 响应文本的提取路径（简化 JSONPath：a.b.c / a[0].b / a[*].b，[*] 收集数组全部元素）。
   * 空路径按顺序回退：body.text → 字符串体 → JSON 序列化。
   */
  textPath: string
  /** 置信度提取路径（可空；解析失败则省略）。 */
  confidencePath: string
  /** 多段文本的拼接符。 */
  join: string
}

/** 各预设的默认字段（用户配置逐字段覆盖）。 */
export const PRESETS: Record<string, Partial<ProviderConfig>> = {
  baidu: {
    endpoint: 'https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic',
    auth: 'token-exchange',
    tokenEndpoint: 'https://aip.baidubce.com/oauth/2.0/token',
    queryParam: 'access_token',
    encoding: 'form',
    template: 'image=${image_base64}&language_type=${lang|CHN_ENG}',
    textPath: 'words_result[*].words',
  },
  paddleocr: {
    endpoint: 'http://127.0.0.1:8868/predict/ocr_system',
    auth: 'none',
    encoding: 'json',
    template: '{"images":["${image_base64}"]}',
    textPath: 'results[0][*].text',
  },
  generic: {
    endpoint: '',
    auth: 'none',
    encoding: 'json',
    template: '{"image":"${image_base64}"}',
    textPath: '',
  },
  /** 无网络自检预设：端点留空即返回 echo 结果，不发起请求。 */
  mock: {
    endpoint: '',
    auth: 'none',
    encoding: 'json',
    template: '',
    textPath: '',
  },
}

export const DEFAULT_FIELDS: Omit<ProviderConfig, 'endpoint'> = {
  auth: 'none',
  apiKey: '',
  secretKey: '',
  headerName: 'Authorization',
  queryParam: 'access_token',
  tokenEndpoint: '',
  encoding: 'json',
  template: '',
  imageMode: 'base64',
  textPath: '',
  confidencePath: '',
  join: '\n',
}

/** 预设 + 用户配置合并（用户逐字段覆盖预设）。 */
export function resolveProvider(id: string, user: Partial<ProviderConfig> | undefined): ProviderConfig {
  return { ...DEFAULT_FIELDS, ...PRESETS[id], ...user } as ProviderConfig
}

/** 模板占位符替换：${name} / ${name|default}。 */
export function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{([A-Za-z0-9_]+)(?:\|([^}]*))?\}/g, (_m, name: string, fallback?: string) => {
    const value = vars[name]
    if (value !== undefined && value !== '') return value
    return fallback ?? ''
  })
}

/**
 * 简化 JSONPath 取值：点分路径，段形如 `a` / `a[0]` / `a[*]`。
 * 返回全部命中值（[*] 展开数组）；路径无法命中返回空数组。
 */
export function jsonPathGet(value: unknown, path: string): unknown[] {
  const segments = path.split('.').filter(Boolean)
  if (segments.length === 0) return [value]
  let current: unknown[] = [value]
  for (const segment of segments) {
    const match = /^([^[\]]*)(?:\[([0-9]+|\*)\])?$/.exec(segment)
    if (match === null) return []
    const key = match[1]
    const index = match[2]
    const next: unknown[] = []
    for (const item of current) {
      let step: unknown
      if (key === '') {
        step = item
      } else if (item !== null && typeof item === 'object' && key in (item as Record<string, unknown>)) {
        step = (item as Record<string, unknown>)[key]
      } else {
        continue
      }
      if (index === undefined) {
        next.push(step)
      } else if (Array.isArray(step)) {
        if (index === '*') next.push(...step)
        else {
          const i = Number(index)
          if (i < step.length) next.push(step[i])
        }
      }
    }
    current = next
    if (current.length === 0) return []
  }
  return current
}

/** 从响应体提取识别文本。 */
export function extractText(body: unknown, textPath: string, joinText: string): string {
  if (textPath !== '') {
    const hits = jsonPathGet(body, textPath)
    if (hits.length === 0) return ''
    return hits.map((hit) => (typeof hit === 'string' ? hit : JSON.stringify(hit))).join(joinText)
  }
  if (body !== null && typeof body === 'object' && 'text' in (body as Record<string, unknown>)) {
    const text = (body as Record<string, unknown>).text
    if (typeof text === 'string') return text
  }
  if (typeof body === 'string') return body
  return JSON.stringify(body)
}

/** 从响应体提取置信度（解析失败返回 undefined）。 */
export function extractConfidence(body: unknown, confidencePath: string): number | undefined {
  if (confidencePath === '') return undefined
  const hits = jsonPathGet(body, confidencePath)
  if (hits.length === 0) return undefined
  const value = Number(hits[0])
  if (Number.isFinite(value)) return value
  return undefined
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
}

export interface LoadedImage {
  data: Buffer
  mime?: string
}

/**
 * 解析图片输入为字节：data: URL / http(s) URL / 本地路径
 * （相对路径按 dsh 启动目录 = workspace 根解析）。
 * 所有来源统一受 maxBytes 上限约束。
 */
export async function loadImage(image: string, maxBytes: number, signal?: AbortSignal): Promise<LoadedImage> {
  const guard = (size: number, where: string): void => {
    if (size > maxBytes) {
      throw new Error(`image too large: ${size} bytes from ${where} (max ${maxBytes})`)
    }
  }
  if (image.startsWith('data:')) {
    const match = /^data:[^;,]*;base64,/.exec(image)
    if (match === null) {
      throw new Error('data: URL must carry base64 content (data:...;base64,...)')
    }
    const payload = image.slice(match[0].length)
    const data = Buffer.from(payload, 'base64')
    guard(data.length, 'data URL')
    return { data }
  }
  if (/^https?:\/\//i.test(image)) {
    const response = await fetch(image, { signal, redirect: 'follow' })
    if (!response.ok) {
      throw new Error(`image fetch failed: HTTP ${response.status}`)
    }
    const data = Buffer.from(await response.arrayBuffer())
    guard(data.length, image)
    const contentType = response.headers.get('content-type')
    return { data, mime: contentType?.split(';')[0]?.trim() || undefined }
  }
  const path = isAbsolute(image) ? image : join(process.cwd(), image)
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`not a file: ${path}`)
  guard(info.size, path)
  const data = await readFile(path)
  return { data, mime: MIME_BY_EXT[extname(path).toLowerCase()] }
}

/** token-exchange 换发 access_token。 */
async function acquireToken(config: ProviderConfig, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  if (config.tokenEndpoint === '') {
    throw new Error(`provider uses auth "token-exchange" but tokenEndpoint is empty`)
  }
  const params = new URLSearchParams()
  params.set('grant_type', 'client_credentials')
  params.set('client_id', config.apiKey)
  params.set('client_secret', config.secretKey)
  const response = await fetch(config.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal,
  })
  if (!response.ok) throw new Error(`token exchange failed: HTTP ${response.status}`)
  const body = (await response.json()) as Record<string, unknown>
  const token = body.access_token ?? body.accessToken ?? body.token
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('token exchange: no access_token in response')
  }
  return token
}

/** 构造识别请求（URL / 请求头 / 请求体）。 */
async function buildRequest(
  config: ProviderConfig,
  imageRef: string,
  data: Buffer,
  lang: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ url: string; headers: Record<string, string>; body: string }> {
  const headers: Record<string, string> = {}
  const imageBase64 = data.toString('base64')
  const vars: Record<string, string> = {
    image_base64: imageBase64,
    image_url: config.imageMode === 'url' ? imageRef : '',
    lang: lang ?? '',
  }

  let body: string
  if (config.encoding === 'raw') {
    headers['Content-Type'] = 'application/octet-stream'
    body = imageBase64
  } else if (config.encoding === 'form') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    const template = config.template !== '' ? config.template : 'image=${image_base64}'
    body = new URLSearchParams(substitute(template, vars)).toString()
  } else {
    headers['Content-Type'] = 'application/json'
    const template = config.template !== '' ? config.template : '{"image":"${image_base64}"}'
    body = substitute(template, vars)
  }

  let url = config.endpoint
  if (config.auth === 'token-exchange') {
    const token = await acquireToken(config, timeoutMs, signal)
    url += (url.includes('?') ? '&' : '?') + encodeURIComponent(config.queryParam) + '=' + encodeURIComponent(token)
  } else if (config.auth === 'query') {
    if (config.apiKey === '') throw new Error('provider uses auth "query" but apiKey is empty')
    url += (url.includes('?') ? '&' : '?') + encodeURIComponent(config.queryParam) + '=' + encodeURIComponent(config.apiKey)
  } else if (config.auth === 'header') {
    if (config.apiKey === '') throw new Error('provider uses auth "header" but apiKey is empty')
    headers[config.headerName || 'Authorization'] = config.apiKey
  }

  return { url, headers, body }
}

export interface RecognizeOptions {
  maxBytes: number
  timeoutMs: number
  signal?: AbortSignal
}

export interface RecognizeResult {
  text: string
  confidence?: number
  provider: string
}

/**
 * 用指定供应商识别一张图片。providerId 仅用于 mock 判定与结果标注；
 * 网络行为完全由 ProviderConfig 决定。
 */
export async function recognize(
  providerId: string,
  config: ProviderConfig,
  image: string,
  lang: string | undefined,
  options: RecognizeOptions,
): Promise<RecognizeResult> {
  if (config.endpoint === '') {
    if (providerId === 'mock') {
      const loaded = await loadImage(image, options.maxBytes, options.signal)
      return {
        provider: 'mock',
        text: `[mock-ocr] received image of ${loaded.data.length} bytes (source: ${image.length > 64 ? image.slice(0, 64) + '…' : image}; lang: ${lang ?? '(none)'}) — configure a real provider (e.g. baidu) to recognize text.`,
        confidence: 1,
      }
    }
    throw new Error(`provider "${providerId}" has no endpoint configured — set providers.${providerId}.endpoint (see preset "generic")`)
  }

  const loaded = await loadImage(image, options.maxBytes, options.signal)
  const effectiveSignal = AbortSignal.any([
    ...(options.signal !== undefined ? [options.signal] : []),
    AbortSignal.timeout(options.timeoutMs),
  ])

  const { url, headers, body } = await buildRequest(config, image, loaded.data, lang, options.timeoutMs, effectiveSignal)
  const response = await fetch(url, { method: 'POST', headers, body, signal: effectiveSignal })
  if (!response.ok) throw new Error(`OCR provider responded HTTP ${response.status}`)

  const contentType = response.headers.get('content-type') ?? ''
  const parsed: unknown = contentType.includes('json') ? await response.json() : await response.text()
  const text = extractText(parsed, config.textPath, config.join)
  const confidence = extractConfidence(parsed, config.confidencePath)
  return { provider: providerId, text, ...(confidence !== undefined ? { confidence } : {}) }
}
