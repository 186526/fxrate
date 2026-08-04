#!/usr/bin/env bash
set -euo pipefail

# Phase 6 dist 一致性门禁：用与 package.json build 完全一致的 esbuild 参数把 src/ 重建到
# 临时目录（不触碰仓库里的 dist/），归一化注入的 GITBUILD/BUILDTIME 时间戳后与仓库中的
# dist/index.cjs 逐字节对比。源码改动但忘记「yarn build 并提交 dist」时 CI 失败——
# 线上（Vercel/Docker）部署的正是提交进仓库的 dist/index.cjs，必须与源码同步。
# 用法：bash scripts/check-dist-consistency.sh （在仓库根目录下执行）

cd "$(dirname "$0")/.."

if [ ! -f dist/index.cjs ]; then
    echo "::error::dist/index.cjs not found — run 'yarn build' and commit it first." >&2
    exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

npx esbuild src/index.ts \
    --minify \
    --entry-names=[name] \
    --format=cjs \
    --platform=node \
    --bundle \
    --outdir="$TMP" \
    --external:sync-request \
    --external:playwright-core \
    --external:chromium-bidi \
    --define:"globalThis.esBuilt=true" \
    --define:"globalThis.GITBUILD=\"$(git rev-parse --short HEAD)\"" \
    --define:"globalThis.BUILDTIME=\"$(date -Iseconds)\"" \
    >/dev/null
mv "$TMP/index.js" "$TMP/index.cjs"

# 归一化：注入的 GITBUILD/BUILDTIME 会被 esbuild 常量折叠进 /info 的 version 字符串
# （`fxrate@<短hash> <ISO8601时间>`，bundle 中不再保留这两个标识符），只有它随
# 构建时间/HEAD 变化，其余内容必须完全一致。
normalize() {
    sed -E 's/fxrate@[0-9a-f]+ [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2}/fxrate@GIT TIME/g' "$1"
}

normalize "$TMP/index.cjs" >"$TMP/rebuilt.norm"
normalize dist/index.cjs >"$TMP/committed.norm"

if ! cmp -s "$TMP/committed.norm" "$TMP/rebuilt.norm"; then
    echo "::error::dist/index.cjs is out of sync with src/. Run 'yarn build' and commit the updated dist/index.cjs." >&2
    exit 1
fi

echo "OK: dist/index.cjs matches a fresh esbuild of src/ (GITBUILD/BUILDTIME normalized away)."
