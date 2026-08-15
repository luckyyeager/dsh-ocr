#!/bin/bash
# @dsh-external/dsh-ocr build (host half).
# 本机无 dsh 源码 checkout：编译期/运行期依赖从已安装的 dsh npm CLI
# checkout 的 node_modules junction 过来，再 tsc 编译 host 入口。
# client 包由 `npm run build:client`（tsdown）单独构建。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 探测 dsh npm CLI checkout（含 node_modules/@deepseek-ai 全套包）
CLI="${DSH_CLI:-}"
if [ -z "$CLI" ]; then
  for candidate in \
    "$HOME/.nvm/versions/node"/*/lib/node_modules/@deepseek-ai/dsh \
    /usr/local/lib/node_modules/@deepseek-ai/dsh \
    /usr/lib/node_modules/@deepseek-ai/dsh; do
    if [ -d "$candidate/node_modules/@deepseek-ai" ]; then CLI="$candidate"; break; fi
  done
fi
if [ -z "$CLI" ] || [ ! -d "$CLI/node_modules" ]; then
  echo "build: cannot locate the dsh npm checkout (set DSH_CLI)" >&2
  exit 1
fi

link() { # link <name> <target-under-CLI/node_modules>
  local name="$1" target="$CLI/node_modules/$2"
  local dest="$ROOT/node_modules/$name"
  if [ ! -e "$target" ]; then
    echo "build: missing dependency target: $target" >&2
    exit 1
  fi
  node -e "
    const fs = require('fs');
    const path = require('path');
    const dest = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(target, dest, 'dir');
  " "$dest" "$target"
}

echo "=== Linking build dependencies (dsh npm checkout: $CLI) ==="
mkdir -p node_modules/@deepseek-ai
link cordis @deepseek-ai/cordis
link schemastery @deepseek-ai/schemastery
link react react
link @deepseek-ai/dsh-tools @deepseek-ai/dsh-tools
link @deepseek-ai/dsh-system-prompt @deepseek-ai/dsh-system-prompt
link @deepseek-ai/dsh-host-webserver @deepseek-ai/dsh-host-webserver
link @deepseek-ai/dsh-client-ui-slots @deepseek-ai/dsh-client-ui-slots
link @deepseek-ai/dsh-client-ui-conversation @deepseek-ai/dsh-client-ui-conversation
link @deepseek-ai/dsh-client-locale @deepseek-ai/dsh-client-locale
link @deepseek-ai/dsh-client-runtime @deepseek-ai/dsh-client-runtime
link @types/node @types/node

echo "=== Compiling src → lib (tsc) ==="
./node_modules/.bin/tsc -p tsconfig.json
echo "=== Host build complete ==="
