# @dsh-external/dsh-ocr

外置第三方 OCR 组合包（bundle）：给 DSH 加一个**模型可调用的 `ocr` 工具**和一个
**Web GUI 识别面板**。provider 层是通用 REST 适配器——绝大多数第三方 OCR 服务
（云厂商 / 私有化部署 / 本地开源服务）都能**纯配置接入**，无需改代码。

- **agent 侧**：`ocr` 工具进 tools schema，agent 遇到截图 / 照片 / 扫描件可直接识别文字
- **面板侧**：输入框上方 OCR 入口，拖拽 / 选择 / 粘贴（Ctrl+V）图片 → 选供应商 → 识别 → 复制
- **安全**：API Key 只存在 host 配置树里，面板请求走同源 API，密钥永不下发浏览器

## 安装

```bash
# 树外安装（写入 profile package.json + bundles，重启后照常装配）
dsh plugin --profile web add /path/to/dsh-external-dsh-ocr-0.0.1.tgz
```

或在注入器环境内热装配：`dev_inject_plugin <本目录>`（免重启生效）。

## 配置

默认 `defaultProvider: mock`（无网络自检，开箱安全）。在
`$DSH_HOME/profiles/<profile>/cordis.patch.yml` 覆盖 `dsh-ocr` 行：

```yaml
- id: dsh-ocr
  config:
    defaultProvider: baidu
    providers:
      baidu:
        apiKey: <你的 API Key>
        secretKey: <你的 Secret Key>
```

### 内置预设

| id | 说明 | 需要配置 |
|---|---|---|
| `baidu` | 百度智能云通用文字识别（token 换发） | `apiKey` + `secretKey` |
| `paddleocr` | 本地 PaddleOCR HubServing（http://127.0.0.1:8868） | 起服务即可，无密钥 |
| `generic` | 通用 JSON POST（`{"image": "..."}`） | `endpoint`（+ 按需 auth/textPath） |
| `mock` | 无网络自检 echo | 无 |

### 通用 REST 接入（自建 / 私有化 / 开源服务）

每个 provider 支持以下字段（逐字段覆盖同 id 预设的默认值）：

| 字段 | 值 | 说明 |
|---|---|---|
| `endpoint` | URL | OCR API 端点 |
| `auth` | `none` / `header` / `query` / `token-exchange` | 鉴权模式 |
| `apiKey` / `secretKey` | string | header/query 用 Key；token-exchange 作 client_id/secret |
| `headerName` | string（默认 `Authorization`） | header 模式请求头名 |
| `queryParam` | string（默认 `access_token`） | query / token-exchange 的查询参数名 |
| `tokenEndpoint` | URL | token-exchange 换发端点（POST grant_type=client_credentials） |
| `encoding` | `json` / `form` / `raw` | 请求体编码 |
| `template` | string | 请求体模板，占位符 `${image_base64}` / `${image_url}` / `${lang}`（可带默认值 `${lang\|CHN_ENG}`） |
| `imageMode` | `base64` / `url` | 图片以 base64 还是公开 URL 嵌入 |
| `textPath` | 简化 JSONPath | 响应文本路径（`a.b.c` / `a[0].b` / `a[*].b`，`[*]` 收集数组全部元素）；空 = 回退 `body.text` → 字符串体 → JSON 序列化 |
| `confidencePath` | 简化 JSONPath | 置信度路径（可空） |
| `join` | string（默认换行） | 多段文本拼接符 |

示例（自建服务）：

```yaml
- id: dsh-ocr
  config:
    defaultProvider: my-ocr
    providers:
      my-ocr:
        endpoint: https://ocr.example.com/recognize
        auth: header
        apiKey: <你的 Key>
        encoding: json
        template: '{"image":"${image_base64}","lang":"${lang|CHN_ENG}"}'
        textPath: data.text
        confidencePath: data.confidence
```

### 其他配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件总开关 |
| `toolEnabled` | `true` | 注册 agent 侧 `ocr` 工具 |
| `panelEnabled` | `true` | 注册面板 API 路由 |
| `timeoutMs` | `30000` | 单次识别协作超时预算（ms） |
| `maxImageBytes` | `20971520` | 图片字节上限（data URL / URL / 本地文件统一约束） |

## 工具用法（模型面）

```
ocr(image, provider?, lang?)
```

- `image`：本地路径（绝对或相对 workspace 根）/ http(s) URL / `data:` base64 URL
- `provider`：供应商 id，缺省用 `defaultProvider`
- `lang`：语言提示（如 `CHN_ENG`），提供方忽略则静默

## 面板 API（同源，仅供面板使用）

- `GET /api/ocr/providers` → `{ ok, defaultProvider, providers[] }`（无密钥）
- `POST /api/ocr/recognize` → body `{ image, provider?, lang? }` → `{ ok, text, confidence?, provider }`

## 构建

```bash
npm run build           # host：探测已安装 dsh npm checkout（DSH_CLI 可覆盖）→ junction 依赖 → tsc
npm run build:client    # client：tsdown 打包 lib/client.js
npm pack                # 产出 dsh-external-dsh-ocr-0.0.1.tgz
```

## 目录

```
src/index.ts            # host 插件：config schema + ocr 工具 + 面板 API 路由
src/engine.ts           # provider 引擎：预设 / 模板替换 / 简化 JSONPath / 图片加载 / token 换发
src/client/index.tsx    # client 面板：conversation.input.dock slot，拖拽/粘贴/识别/复制
cordis.patch.yml        # bundle patch：dsh-ocr 行 + 默认配置
```
