/**
 * @dsh-external/dsh-ocr — client half.
 *
 * OcrChip：注册进 `conversation.input.dock`（list 槽，session 作用域），
 * 渲染为 composer 卡片上方的独立行。点击弹出识别面板：
 * 拖拽 / 选择 / 粘贴图片 → 选供应商 → 识别 → 复制文本。
 *
 * 识别请求走 host 侧同源 API（POST /api/ocr/recognize），密钥
 * 永不进入浏览器。供应商清单来自 GET /api/ocr/providers。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Context } from 'cordis'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

const NS = 'ocr'
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

// ── i18n ────────────────────────────────────────────────────────────────────

const zh = {
  chip: 'OCR',
  panelTitle: '图片文字识别',
  provider: '供应商',
  providerHint: '未配置的供应商在 host 侧补配置',
  lang: '语言（可留空）',
  drop: '拖拽图片到此处，或点击选择 / 粘贴（Ctrl+V）',
  recognize: '识别',
  recognizing: '识别中…',
  copy: '复制',
  copied: '已复制',
  clear: '清空',
  confidence: '置信度',
  noText: '（未识别到文本）',
  errBadImage: '请先提供图片',
  errTooLarge: '图片超过 20MB 上限',
  errLoadProviders: '供应商清单加载失败',
} as const

const en = {
  chip: 'OCR',
  panelTitle: 'Image OCR',
  provider: 'Provider',
  providerHint: 'Unconfigured providers are resolved on the host',
  lang: 'Language (optional)',
  drop: 'Drop an image here, click to choose, or paste (Ctrl+V)',
  recognize: 'Recognize',
  recognizing: 'Recognizing…',
  copy: 'Copy',
  copied: 'Copied',
  clear: 'Clear',
  confidence: 'Confidence',
  noText: '(no text recognized)',
  errBadImage: 'Provide an image first',
  errTooLarge: 'Image exceeds the 20MB limit',
  errLoadProviders: 'Failed to load provider list',
} as const

// ── styles ──────────────────────────────────────────────────────────────────

const css = `.Ocr_root{position:relative;flex:none;display:inline-flex}
.Ocr_trigger{height:28px;min-width:0;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:24px;outline:none;align-items:center;gap:4px;padding:0 8px 0 6px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}
.Ocr_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.Ocr_trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.Ocr_glyph{flex:none;display:inline-flex}
.Ocr_glyph svg{width:14px;height:14px}
.Ocr_panel{position:absolute;top:calc(100% + 6px);left:0;z-index:60;width:300px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-tip);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.12);padding:10px;display:flex;flex-direction:column;gap:8px}
.Ocr_title{font:var(--dsw-font-xs-13);font-family:Inter,var(--dsw-font-family);color:var(--dsw-alias-label-primary);font-weight:600;line-height:20px}
.Ocr_row{align-items:center;gap:6px;display:flex}
.Ocr_label{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px}
.Ocr_select{flex:1;min-width:0;height:26px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-interactive-bg);color:var(--dsw-alias-label-primary);font-size:12px;padding:0 6px;outline:none}
.Ocr_input{flex:1;min-width:0;height:26px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-interactive-bg);color:var(--dsw-alias-label-primary);font-size:12px;padding:0 8px;outline:none}
.Ocr_drop{min-height:64px;box-sizing:border-box;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;cursor:pointer;align-items:center;justify-content:center;gap:8px;padding:8px;color:var(--dsw-alias-label-caption);font-size:12px;line-height:16px;display:flex;text-align:center}
.Ocr_dropActive{border-color:var(--dsw-alias-interactive-accent);background:var(--dsw-alias-interactive-bg-hover)}
.Ocr_preview{max-height:120px;max-width:100%;border-radius:6px;display:block;margin:0 auto}
.Ocr_actions{justify-content:flex-end;gap:6px;display:flex}
.Ocr_btn{height:26px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;outline:none;align-items:center;gap:4px;padding:0 10px;font-size:12px;font-weight:500;line-height:16px;display:inline-flex}
.Ocr_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.Ocr_btn:disabled{cursor:default;opacity:.5}
.Ocr_btnPrimary{color:#fff;background:var(--dsw-alias-interactive-accent);border-color:transparent}
.Ocr_btnPrimary:hover:not(:disabled){background:var(--dsw-alias-interactive-accent)}
.Ocr_result{max-height:180px;margin:0;box-sizing:border-box;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-interactive-bg);padding:8px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word}
.Ocr_meta{align-items:center;justify-content:space-between;gap:8px;display:flex}
.Ocr_metaText{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
.Ocr_error{color:var(--dsw-alias-state-business-danger, #d0453a);font-size:12px;line-height:16px}`

const cssTagId = '@dsh-external/dsh-ocr/OcrChip.module.css'
if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${cssTagId}"]`) === null) {
  const tag = document.createElement('style')
  tag.dataset.plugin = '@dsh-external/dsh-ocr'
  tag.dataset.pluginCss = cssTagId
  tag.textContent = css
  document.head.appendChild(tag)
}

// ── 数据面 ──────────────────────────────────────────────────────────────────

interface ProvidersData {
  ok: true
  defaultProvider: string
  providers: string[]
}

interface RecognizeData {
  ok: true
  text: string
  confidence?: number
  provider: string
}

type ApiError = { ok: false; code: string; message: string }

const glyph = (
  <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" fill="none">
    <rect x="1.6" y="1.6" width="10.8" height="10.8" rx="2" stroke="currentColor" strokeWidth="1.2" />
    <path d="M1.6 4.2h10.8M4.4 7.2l1.8 1.8 3.6-3.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

interface OcrChipProps {
  /** locale 共享：register({ locale }) 注入的 t（宽松接收）。 */
  t: any
}

function OcrChip({ t }: OcrChipProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [providers, setProviders] = useState<ProvidersData | null>(null)
  const [providersError, setProvidersError] = useState(false)
  const [providerId, setProviderId] = useState('')
  const [lang, setLang] = useState('')
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RecognizeData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [dragActive, setDragActive] = useState(false)

  const loadProviders = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/ocr/providers', { cache: 'no-store' })
      if (!res.ok) throw new Error(String(res.status))
      const body = (await res.json()) as ProvidersData | ApiError
      if (body.ok !== true) throw new Error(body.message)
      setProviders(body)
      setProvidersError(false)
      setProviderId((current) => (current === '' ? body.defaultProvider : current))
    } catch {
      setProvidersError(true)
    }
  }, [])

  useEffect(() => {
    if (open) void loadProviders()
  }, [open, loadProviders])

  // 面板外部点击 / Esc 关闭
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target) === true) return
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // 粘贴图片
  useEffect(() => {
    if (!open) return
    const onPaste = (e: ClipboardEvent): void => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'))
      if (item === undefined) return
      const file = item.getAsFile()
      if (file === null) return
      if (file.size > MAX_IMAGE_BYTES) {
        setError(t('errTooLarge'))
        return
      }
      e.preventDefault()
      void fileToDataUrl(file).then((url) => {
        setImageUrl(url)
        setResult(null)
        setError(null)
      })
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [open, t])

  const acceptFile = useCallback((file: File | undefined | null): void => {
    if (file === undefined || file === null) return
    if (file.size > MAX_IMAGE_BYTES) {
      setError(t('errTooLarge'))
      return
    }
    void fileToDataUrl(file).then((url) => {
      setImageUrl(url)
      setResult(null)
      setError(null)
    })
  }, [t])

  const recognize = useCallback(async (): Promise<void> => {
    if (imageUrl === null) {
      setError(t('errBadImage'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/ocr/recognize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: imageUrl,
          ...(providerId !== '' ? { provider: providerId } : {}),
          ...(lang.trim() !== '' ? { lang: lang.trim() } : {}),
        }),
      })
      const body = (await res.json()) as RecognizeData | ApiError
      if (body.ok !== true) throw new Error(body.message)
      setResult(body)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setResult(null)
    } finally {
      setBusy(false)
    }
  }, [imageUrl, providerId, lang, t])

  const copy = useCallback(async (): Promise<void> => {
    if (result === null) return
    try {
      await navigator.clipboard.writeText(result.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* 剪贴板不可用则忽略 */
    }
  }, [result])

  return (
    <span ref={rootRef} className="Ocr_root" data-ocr-chip="">
      <button
        type="button"
        className="Ocr_trigger"
        aria-label={t('chip')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="Ocr_glyph" aria-hidden="true">{glyph}</span>
        {t('chip')}
      </button>
      {open && (
        <div className="Ocr_panel" role="dialog" aria-label={t('panelTitle')}>
          <div className="Ocr_title">{t('panelTitle')}</div>
          <div className="Ocr_row">
            <span className="Ocr_label">{t('provider')}</span>
            <select
              className="Ocr_select"
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
              disabled={providers === null}
            >
              {providers?.providers.map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
          </div>
          <div className="Ocr_row">
            <span className="Ocr_label">{t('lang')}</span>
            <input
              className="Ocr_input"
              value={lang}
              placeholder="CHN_ENG"
              onChange={(e) => setLang(e.target.value)}
            />
          </div>
          <div
            className={`Ocr_drop ${dragActive ? 'Ocr_dropActive' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click()
            }}
            onDragOver={(e) => {
              e.preventDefault()
              setDragActive(true)
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragActive(false)
              acceptFile(e.dataTransfer.files?.[0])
            }}
          >
            {imageUrl !== null
              ? <img className="Ocr_preview" src={imageUrl} alt="preview" />
              : t('drop')}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              acceptFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          {providersError && <div className="Ocr_error">{t('errLoadProviders')}</div>}
          {error !== null && <div className="Ocr_error">{error}</div>}
          {result !== null && (
            <>
              <pre className="Ocr_result">{result.text !== '' ? result.text : t('noText')}</pre>
              <div className="Ocr_meta">
                <span className="Ocr_metaText">
                  {result.provider}
                  {result.confidence !== undefined ? ` · ${t('confidence')} ${result.confidence.toFixed(3)}` : ''}
                </span>
                <button type="button" className="Ocr_btn" onClick={() => void copy()}>
                  {copied ? t('copied') : t('copy')}
                </button>
              </div>
            </>
          )}
          <div className="Ocr_actions">
            <button
              type="button"
              className="Ocr_btn"
              disabled={busy || (imageUrl === null && result === null)}
              onClick={() => {
                setImageUrl(null)
                setResult(null)
                setError(null)
              }}
            >
              {t('clear')}
            </button>
            <button
              type="button"
              className="Ocr_btn Ocr_btnPrimary"
              disabled={busy || imageUrl === null}
              onClick={() => void recognize()}
            >
              {busy ? t('recognizing') : t('recognize')}
            </button>
          </div>
        </div>
      )}
    </span>
  )
}

// ── 插件体 ──────────────────────────────────────────────────────────────────

interface ClientContext extends Context {
  slots: SlotRegistry
  locale: {
    register(namespace: string, dict: Record<string, unknown>): unknown
  }
}

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    ctx.locale.register(NS, { zh, en })
    return () => {}
  }, '@dsh-external/dsh-ocr: dictionaries')
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'dsh-ocr',
    order: 50,
    locale: NS as unknown as 'conversation',
  }, OcrChip))
}

export { OcrChip }
