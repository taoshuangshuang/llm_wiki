#!/bin/zsh
# 编译当前源码并替换安装版；成功后清理构建目录中的应用副本。
set -euo pipefail
cd "${0:A:h}"
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

for task_node in "${commands[node]:-}" \
  "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" \
  /opt/homebrew/opt/node/bin/node /opt/homebrew/opt/node@24/bin/node /opt/homebrew/opt/node@22/bin/node; do
  [[ -x "$task_node" ]] || continue
  if "$task_node" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22 ? 0 : 1)' 2>/dev/null; then
    export PATH="${task_node:h}:$PATH"
    break
  fi
done

task_installed="/Applications/LLM Wiki.app"
task_bundle="$PWD/src-tauri/target/release/bundle/macos/LLM Wiki.app"
task_registry="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if pgrep -f '^/Applications/LLM Wiki[.]app/Contents/MacOS/llm-wiki' >/dev/null; then
  print -u2 -- "请先退出 LLM Wiki 安装版，再执行更新。"
  exit 1
fi

[[ -d node_modules ]] || npm ci
npm run tauri -- build --bundles app

# 在同一磁盘准备完整新包，再替换安装版；失败时恢复原应用。
task_stage=$(mktemp -d /Applications/.llm-wiki-update.XXXXXX)
cleanup() {
  if [[ ! -d "$task_installed" && -d "$task_stage/previous" ]]; then
    mv "$task_stage/previous" "$task_installed"
  fi
  rm -rf -- "$task_stage"
}
trap cleanup EXIT
ditto "$task_bundle" "$task_stage/current"
[[ ! -e "$task_installed" ]] || mv "$task_installed" "$task_stage/previous"
mv "$task_stage/current" "$task_installed"
"$task_registry" -u "$task_bundle" >/dev/null 2>&1 || true
rm -rf -- "$task_bundle"
"$task_registry" -f "$task_installed"
print -- "安装版已更新为当前源码构建的版本：$task_installed"
