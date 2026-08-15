# @dsh-external/dsh-ocr

外置第三方 OCR 组合包（bundle）：给 DSH 加一个**全局可用的 `ocr` 工具**
（默认开启，可在设置面板一键关闭），全部配置走 **DSH 设置面板 GUI**（设置 > 插件 >
OCR 卡片），改动即时生效。provider 层是通用 REST 适配器——绝大多数第三方 OCR 服务
（云厂商 / 私有化部署 / 本地开源服务）都能**纯配置接入**，无需改代码。

- **agent 侧**：`ocr` 工具进 tools schema，agent 遇到截图 / 照片 / 扫描件可直接识别文字
- **设置侧**：设置面板里的 OCR 卡片——开关、默认供应商、超时/大小上限、供应商字段（端点 / 鉴权 / 密钥 / 模板 / 响应路径）全部 GUI 化
- **安全**：`apiKey` / `secretKey` 是 `role('secret')` 写only字段——字面值永不下发浏览器，卡片只显示"已配置"徽标

## 安装

```bash
# 树外安装（写入 profile package.json + bundles，重启后照常装配）
dsh plugin --profile web add /path/to/dsh-external-dsh-ocr-0.0.2.tgz
```

或在注入器环境内热装配：`dev_inject_plugin <本目录>`（免重启生效）。

## 配置（设置面板 GUI）

打开 **设置 > 插件 > OCR**：

| 设置 | 默认 | 说明 |
|---|---|---|
| 启用 OCR | 开 | 插件总开关 |
| 注册 ocr 工具 | 开 | agent 能否调用 ocr（全局默认开启） |
| 默认供应商 | `mock` | 调用未指定 provider 时使用 |
| 超时 / 图片字节上限 | 30000 / 20MB | 单次识别预算与图片大小约束 |
| 供应商 id | — | 内置预设 baidu / paddleocr / generic / mock，或自定义新 id |
| 供应商字段 | — | endpoint / auth / apiKey / secretKey / tokenEndpoint / headerName / queryParam / encoding / imageMode / template / textPath / confidencePath / join；留空保存 = 清除该字段（回落预设/默认值） |

### 内置预设

| id | 说明 | 需要配置 |
|---|---|---|
| `baidu` | 百度智能云通用文字识别（token 换发） | apiKey + secretKey |
| `paddleocr` | 本地 PaddleOCR HubServing（http://127.0.0.1:8868） | 起服务即可，无密钥 |
| `generic` | 通用 JSON POST（`{"image": "..."}`） | endpoint（+ 按需 auth/textPath） |
| `mock` | 无网络自检 echo | 无 |

### 通用 REST 接入字段（自建 / 私有化 / 开源服务）

| 字段 | 值 | 说明 |
|---|---|---|
| `endpoint` | URL | OCR API 端点 |
| `auth` | `none` / `header` / `query` / `token-exchange` | 鉴权模式 |
| `apiKey` / `secretKey` | string（写only） | header/query 用 Key；token-exchange 作 client_id/secret |
| `headerName` | 默认 `Authorization` | header 模式请求头名 |
| `queryParam` | 默认 `access_token` | query / token-exchange 的查询参数名 |
| `tokenEndpoint` | URL | token-exchange 换发端点（POST grant_type=client_credentials） |
| `encoding` | `json` / `form` / `raw` | 请求体编码 |
| `template` | string | 请求体模板，占位符 `${image_base64}` / `${image_url}` / `${lang}`（可带默认值 `${lang\|CHN_ENG}`） |
| `imageMode` | `base64` / `url` | 图片以 base64 还是公开 URL 嵌入 |
| `textPath` | 简化 JSONPath | 响应文本路径（`a.b.c` / `a[0].b` / `a[*].b`，`[*]` 收集数组全部元素）；空 = 回退 `body.text` → 字符串体 → JSON 序列化 |
| `confidencePath` | 简化 JSONPath | 置信度路径（可空） |
| `join` | 默认换行 | 多段文本拼接符 |

设置面板写的是 `dsh-ocr` settings 命名空间的 user 层；等价的手工配置方式仍是
`$DSH_HOME/profiles/<profile>/cordis.patch.yml` 覆盖 `dsh-ocr` 行（示例见
`cordis.patch.yml` 头部注释）。

## 工具用法（模型面）

```
ocr(image, provider?, lang?)
```

- `image`：本地路径（绝对或相对 workspace 根）/ http(s) URL / `data:` base64 URL
- `provider`：供应商 id，缺省用默认供应商
- `lang`：语言提示（如 `CHN_ENG`），提供方忽略则静默

## 构建

```bash
npm run build           # host：探测已安装 dsh npm checkout（DSH_CLI 可覆盖）→ junction 依赖 → tsc
npm run build:client    # client：tsdown 打包 lib/client.js
npm pack                # 产出 dsh-external-dsh-ocr-0.0.2.tgz
```

## 目录

```
src/index.ts            # host 插件：settings 命名空间接入 + ocr 工具（可开关、改动即时重建）
src/engine.ts           # provider 引擎：预设 / 模板替换 / 简化 JSONPath / 图片加载 / token 换发
src/client/index.tsx    # client 设置卡片：settings.plugin.item slot，staged 保存 + secret 写only字段
cordis.patch.yml        # bundle patch：dsh-ocr 行 + 默认配置
```
