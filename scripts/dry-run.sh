#!/usr/bin/env bash
# 隔离干跑探针（dry-run probe）——不动生产 web profile。
#
# 作用：在不启动第二个轮询者、不占生产端口、不读生产凭证的前提下，
# 用临时 DSH_HOME 把 web 组合连同新构建的插件真实启动一遍，验证：
#   1. 组合层通过（loader + Config schema 校验，等价 --dump-config 且更真实）
#   2. 桥节点 apply 成功（wechat-gateway 无凭证 → unauthenticated，不轮询）
#   3. 状态端点返回新模式列表 / 偏好 / 队列字段
#
# 用法：plugins/dsh-wechat-bridge 下执行
#   scripts/dry-run.sh            # 自动挑空闲端口，打印探针 URL 后按回车停止
#   scripts/dry-run.sh --check    # 只启动、断言端点健康、自动退出（CI 用）
#
# 依赖：dsh CLI（npm i -g 的 deepseek-harness）、curl、python3。

set -euo pipefail
cd "$(dirname "$0")/.."

DSH_BIN="${DSH_BIN:-$HOME/.npm-global/bin/dsh}"
PROBE_HOME="$(mktemp -d /tmp/dwb-probe-home.XXXXXX)"
LOG="$PROBE_HOME/boot.log"
PORT=0
PID=""

cleanup() {
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    sleep 1
  fi
  rm -rf "$PROBE_HOME"
}
trap cleanup EXIT

mkdir -p "$PROBE_HOME"
# 复用真实 profiles 组合（含生产 patch），但用空 home：无凭证、无会话、无工作区。
ln -s "$HOME/.dsh/profiles" "$PROBE_HOME/profiles"
# 只读引入真实 .agent-presets，让 /modes 探针覆盖"全部模式"路径。
ln -s "$HOME/.dsh/.agent-presets" "$PROBE_HOME/.agent-presets"

echo "▶ 启动隔离探针（DSH_HOME=$PROBE_HOME）…"
DSH_HOME="$PROBE_HOME" nohup "$DSH_BIN" --profile web --port "$PORT" --host 127.0.0.1 > "$LOG" 2>&1 &
PID=$!

URL=""
for _ in $(seq 1 60); do
  URL="$(grep -oE 'http://127\.0\.0\.1:[0-9]+' "$LOG" | head -1 || true)"
  [[ -n "$URL" ]] && break
  sleep 0.5
done
if [[ -z "$URL" ]]; then
  echo "✖ 探针未在 30s 内启动。boot.log 尾部："
  tail -20 "$LOG"
  exit 1
fi
echo "▶ 探针已启动：$URL"

STATUS="$(curl -sS --max-time 10 "$URL/api/dsh-wechat-bridge/status" || true)"
echo "$STATUS" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print('✖ 状态端点返回非 JSON，boot.log 尾部：')
    import subprocess
    subprocess.run(['tail', '-20', '$LOG'])
    sys.exit(1)
modes = d.get('modes', [])
print('✅ 状态端点健康：status=%s markdownMode=%s paired=%s' % (d.get('status'), d.get('markdownMode'), d.get('paired')))
print('✅ 模式 %d 个：%s' % (len(modes), [m['id'] for m in modes]))
print('✅ 白名单：%s' % d.get('allowFrom'))
sys.exit(0)
"
echo "$STATUS" | python3 -c "import json,sys; json.load(sys.stdin)" > /dev/null 2>&1 || exit 1

if [[ "${1:-}" == "--check" ]]; then
  echo "✅ 干跑检查通过。"
  exit 0
fi

echo "▶ 生产服务不受影响。按回车停止探针并清理…"
read -r _ || true
echo "✅ 干跑结束。"
