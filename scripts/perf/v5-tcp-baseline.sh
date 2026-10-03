#!/usr/bin/env bash
# TuneX V5-WP3 —— 性能基线入口（TCP: DIRECT / RELAY；V5.1a: TLS / WS）。
#
#   bash scripts/perf/v5-tcp-baseline.sh                       # 默认 direct+relay（TCP）
#   bash scripts/perf/v5-tcp-baseline.sh --profile full         # 发布前人工对比用
#   bash scripts/perf/v5-tcp-baseline.sh --scenarios direct
#   bash scripts/perf/v5-tcp-baseline.sh --scenarios tls        # 需要 openssl（现场生成自签证书）
#   bash scripts/perf/v5-tcp-baseline.sh --scenarios direct relay tls ws
#
# 这个脚本只做三件事：构建 Agent、检查依赖、调用 Python 采集器。**它不做判定**：
# 性能基线不是 CI 门槛（§5.4「不要一开始用脆弱绝对阈值阻断 CI」），共享 Runner
# 上的毫秒级硬门槛只会制造随机红灯。判断"是否退化"靠的是相对趋势与人工复核。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 is required (standard library only)" >&2
  exit 1
fi
if ! command -v go >/dev/null 2>&1; then
  echo "error: go is required to build the agent binary" >&2
  exit 1
fi

BIN="${TUNEX_PERF_AGENT_BIN:-$REPO_ROOT/scripts/perf/.bin/tunex-agent}"
mkdir -p "$(dirname "$BIN")"

echo "==> building agent binary ($BIN)"
# 基线必须测"当前工作树"的代码，而不是一个可能已经过期的产物。
(cd "$REPO_ROOT/agent" && go build -o "$BIN" .)

echo "==> running baseline"
exec python3 "$REPO_ROOT/scripts/perf/v5-tcp-baseline.py" --agent-binary "$BIN" "$@"
