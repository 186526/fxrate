#!/usr/bin/env bash
set -euo pipefail

# Phase 6 镜像 smoke：验证构建出的后端进程/镜像能启动并对外提供核心契约。
# 发布门禁默认「确定性」：/info、/readyz 只验证契约形状（200/503 + 字段），
# 不等真实银行就绪——冷容器未加载关键源时 /readyz 503 degraded 属预期；
# --require-ready 是可选开关（需要真实上游，仅供本机人工验证，不进 CI）。
# 三种模式：
#   docker（默认，CI 发布门禁用）：docker build 出 fxrate 镜像，起容器，跑检查，trap 清理。
#   local（可无 Docker 测试）：用已提交的 dist/index.cjs 起本地进程，跑同一组检查。
#   --url：对已运行的后端跑同一组检查。
# 用法：bash scripts/image-smoke.sh [--local|--url URL] [--port N] [--image NAME]
#       [--skip-build] [--require-ready|--no-require-ready] [--wait-ready SECONDS] [--keep]

MODE=docker
PORT=18081
IMAGE=fxrate-backend-smoke
CONTAINER=fxrate-backend-smoke
REQUIRE_READY=no
WAIT_READY=300
URL=""
KEEP=0
SKIP_BUILD=0
WORKDIR=""

usage() {
    cat <<'EOF'
Usage: bash scripts/image-smoke.sh [options]

  --local               Run against a locally spawned `node dist/index.cjs` (no Docker).
  --url URL             Skip spawning; run checks against an already-running backend URL.
  --port N              Backend port (docker/local). Default 18081.
  --image NAME          Docker image name. Default fxrate-backend-smoke.
  --container NAME      Docker container name. Default fxrate-backend-smoke.
  --skip-build          Use an existing --image without building it (CD reuse).
  --require-ready       OPT-IN: wait until /readyz reports ok (needs real upstreams;
                        NOT part of the deterministic release smoke).
  --wait-ready SECONDS  Max seconds to wait for readiness. Default 300.
  --keep                Do not remove the Docker container on exit (debugging).
  -h, --help            Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --local) MODE=local; shift ;;
        --url) URL="$2"; shift 2 ;;
        --port) PORT="$2"; shift 2 ;;
        --image) IMAGE="$2"; shift 2 ;;
        --container) CONTAINER="$2"; shift 2 ;;
        --skip-build) SKIP_BUILD=1; shift ;;
        --require-ready) REQUIRE_READY=yes; shift ;;
        --no-require-ready) REQUIRE_READY=no; shift ;;
        --wait-ready) WAIT_READY="$2"; shift 2 ;;
        --keep) KEEP=1; shift ;;
        -h | --help) usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
done

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# 临时目录放中间产物（避免固定 /tmp 文件互相踩踏）；exit 时清理。
WORKDIR=$(mktemp -d)
trap cleanup EXIT
cleanup() {
    rm -rf "$WORKDIR"
    if [[ "$MODE" == "docker" && "$KEEP" != "1" ]]; then
        docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    elif [[ "$MODE" == "local" && -n "${LOCAL_PID:-}" ]]; then
        kill "$LOCAL_PID" 2>/dev/null || true
        wait "$LOCAL_PID" 2>/dev/null || true
    fi
}

wait_http() {
    local url="$1" timeout_seconds="$2"
    local deadline=$((SECONDS + timeout_seconds))
    until curl --silent --show-error --output /dev/null --max-time 2 "$url" 2>/dev/null; do
        if [[ $SECONDS -ge $deadline ]]; then
            fail "server did not answer $url within ${timeout_seconds}s"
        fi
        sleep 1
    done
}

# 用 node 解析 JSON（bash 无健壮 JSON），node 一定随本仓库 Node 环境存在。
json_get() {
    local json="$1" path="$2"
    node -e "const fs=require('fs');const d=JSON.parse(process.argv[1]);const p=process.argv[2].split('.');let v=d;for(const k of p){if(v==null)process.exit(3);v=v[k];}if(typeof v==='object'&&v!==null){console.log(JSON.stringify(v));}else{console.log(String(v));}" "$json" "$path"
}

check_backend() {
    local base="$1"

    local info_status info_body
    info_status=$(curl --silent --show-error --output "$WORKDIR/info.json" --write-out '%{http_code}' --max-time 10 "$base/info")
    info_body=$(cat "$WORKDIR/info.json")
    # 冷启动关键源未就绪时 /info 可能 503 degraded——契约是「进程存活 + 字段形状」。
    if [[ "$info_status" != "200" && "$info_status" != "503" ]]; then
        fail "/info returned HTTP $info_status (expected 200 or 503)"
    fi
    local status_field version_field api_field
    status_field=$(json_get "$info_body" status) || fail "/info body missing status: $info_body"
    version_field=$(json_get "$info_body" version) || fail "/info body missing version: $info_body"
    api_field=$(json_get "$info_body" apiVersion) || fail "/info body missing apiVersion: $info_body"
    [[ "$status_field" == "ok" || "$status_field" == "degraded" ]] || fail "/info status='$status_field'"
    [[ -n "$version_field" ]] || fail "/info version is empty"
    [[ "$api_field" == "v1" ]] || fail "/info apiVersion='$api_field' (expected v1)"
    pass "/info HTTP $info_status status=$status_field version=$version_field"

    local ready_status ready_body
    ready_status=$(curl --silent --show-error --output "$WORKDIR/ready.json" --write-out '%{http_code}' --max-time 10 "$base/readyz")
    ready_body=$(cat "$WORKDIR/ready.json")
    if [[ "$ready_status" != "200" && "$ready_status" != "503" ]]; then
        fail "/readyz returned HTTP $ready_status"
    fi
    local ready_field
    ready_field=$(json_get "$ready_body" status) || fail "/readyz body missing status: $ready_body"
    pass "/readyz HTTP $ready_status status=$ready_field"

    local metrics_body
    metrics_body=$(curl --fail --silent --show-error --max-time 10 "$base/metrics") || fail "/metrics curl failed"
    for family in \
        fxrate_rpc_batch_items fxrate_rpc_rejected_total fxrate_work_active \
        fxrate_work_queue_wait_seconds fxrate_source_fetch_seconds fxrate_chromium_active \
        fxrate_cache_hits_total fxrate_shutdown_seconds; do
        grep -q "^# HELP ${family} " <<<"$metrics_body" || fail "/metrics missing family $family"
        grep -q "^# TYPE ${family} " <<<"$metrics_body" || fail "/metrics missing TYPE $family"
    done
    pass "/metrics exposes all 8 metric families"

    local rpc_body rpc_code
    rpc_code=$(curl --silent --show-error --output "$WORKDIR/rpc.json" --write-out '%{http_code}' --max-time 10 \
        --header 'content-type: application/json' \
        --data '{"jsonrpc":"2.0","id":1,"method":"instanceInfo","params":{}}' \
        "$base/v1/jsonrpc")
    rpc_body=$(cat "$WORKDIR/rpc.json")
    [[ "$rpc_code" == "200" ]] || fail "JSON-RPC instanceInfo returned HTTP $rpc_code"
    json_get "$rpc_body" jsonrpc | grep -qx '2.0' || fail "JSON-RPC bad jsonrpc version: $rpc_body"
    json_get "$rpc_body" id | grep -qx '1' || fail "JSON-RPC bad id: $rpc_body"
    local rpc_version
    rpc_version=$(json_get "$rpc_body" result.version) || fail "JSON-RPC result.version missing: $rpc_body"
    [[ -n "$rpc_version" ]] || fail "JSON-RPC result.version empty"
    pass "JSON-RPC instanceInfo id=1 result.version=$rpc_version"

    if [[ "$REQUIRE_READY" == "yes" ]]; then
        local deadline=$((SECONDS + WAIT_READY))
        local s sbody
        while true; do
            s=$(curl --silent --show-error --output "$WORKDIR/ready.json" --write-out '%{http_code}' --max-time 10 "$base/readyz" 2>/dev/null || echo 000)
            sbody=$(cat "$WORKDIR/ready.json")
            if [[ "$s" == "200" ]]; then
                json_get "$sbody" status | grep -qx 'ok' && break
            fi
            if [[ $SECONDS -ge $deadline ]]; then
                fail "/readyz did not reach ok within ${WAIT_READY}s (last HTTP $s)"
            fi
            sleep 3
        done
        local ok_info
        ok_info=$(curl --silent --show-error --output "$WORKDIR/info.json" --write-out '%{http_code}' --max-time 10 "$base/info")
        [[ "$ok_info" == "200" ]] || fail "/info not HTTP 200 once ready (got $ok_info)"
        json_get "$(cat "$WORKDIR/info.json")" status | grep -qx 'ok' || fail "/info status not ok once ready"
        pass "/readyz + /info reached status ok"
    fi
}

cd "$(dirname "$0")/.."

if [[ -n "$URL" ]]; then
    MODE=url
    wait_http "$URL/info" 30
    check_backend "$URL"
elif [[ "$MODE" == "docker" ]]; then
    if [[ "$SKIP_BUILD" != "1" ]]; then
        docker build --tag "$IMAGE" .
	fi
	docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
	REFRESH_ENV=(--env FXRATE_DISABLE_REFRESH=1)
	if [[ "$REQUIRE_READY" == "yes" ]]; then
		REFRESH_ENV=(--env FXRATE_REFRESH_INTERVAL_MS=60000)
	fi
	docker run --detach --name "$CONTAINER" --publish "127.0.0.1:${PORT}:8080" \
		--env PORT=8080 "${REFRESH_ENV[@]}" "$IMAGE"
    wait_http "http://127.0.0.1:${PORT}/info" 30
    check_backend "http://127.0.0.1:${PORT}"
else
    [[ -f dist/index.cjs ]] || fail "dist/index.cjs missing — run 'yarn build' first"
    if (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
        exec 3>&- || true
        fail "port $PORT already in use — pass --port to pick another"
    fi
	if [[ "$REQUIRE_READY" == "yes" ]]; then
		PORT="$PORT" FXRATE_REFRESH_INTERVAL_MS=60000 node dist/index.cjs >"$WORKDIR/backend.log" 2>&1 &
	else
		PORT="$PORT" FXRATE_DISABLE_REFRESH=1 node dist/index.cjs >"$WORKDIR/backend.log" 2>&1 &
	fi
    LOCAL_PID=$!
    wait_http "http://127.0.0.1:${PORT}/info" 30
    check_backend "http://127.0.0.1:${PORT}"
fi

echo "OK: image smoke passed (mode=$MODE)."
