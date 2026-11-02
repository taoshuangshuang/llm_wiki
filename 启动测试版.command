#!/bin/zsh
# 启动本地桌面测试版：自动选择可用运行时，编译后打开应用窗口。
set -euo pipefail
cd "${0:A:h}"
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

fail() {
  print -u2 -- "$1"
  if [[ -t 0 ]]; then read -r "?按回车关闭窗口…"; fi
  exit 1
}

# Vite 8 需要 Node 20.19+ 或 22.12+；优先使用系统版本，再查找已有运行时。
task_node_found=false
for task_node in "${commands[node]:-}" \
  "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" \
  /opt/homebrew/opt/node/bin/node /opt/homebrew/opt/node@24/bin/node /opt/homebrew/opt/node@22/bin/node; do
  [[ -x "$task_node" ]] || continue
  if "$task_node" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22 ? 0 : 1)' 2>/dev/null; then
    export PATH="${task_node:h}:$PATH"
    task_node_found=true
    break
  fi
done
[[ "$task_node_found" == true ]] || fail "未找到兼容的 Node.js，请安装 Node 22.12+ 或 Node 24 后重试。"
command -v npm >/dev/null || fail "未找到 npm，请安装包含 npm 的 Node.js。"
command -v cargo >/dev/null || fail "未找到 Rust/Cargo，请先安装 Rust 1.88+。"
command -v protoc >/dev/null || fail "未找到 protoc，可执行 brew install protobuf 后重试。"

if lsof -nP -iTCP:1420 -sTCP:LISTEN >/dev/null 2>&1; then
  fail "1420 端口已被占用。若测试版已启动，请使用现有窗口；否则先停止占用端口的开发服务。"
fi

print -- "启动 LLM Wiki 测试版（Node $(node --version)）"
print -- "首次编译可能较慢。运行时请保留终端，停止测试版可按 Ctrl+C。"
[[ -d node_modules ]] || npm ci
[[ -d mcp-server/node_modules ]] || npm --prefix mcp-server ci
npm run mcp:build
exec npm run tauri -- dev
