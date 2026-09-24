#!/usr/bin/env bash
# NET-01 双租户 E2E —— 环境销毁（幂等）
#
# 只销毁 net01-* 独立栈（独立网络 net01_net / 独立容器名 / 独立数据卷），
# 不动 relayx 栈、不动 /opt/TuneX 栈、不动其它任何容器。
set -euo pipefail

REPO=${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
HERE="$REPO/scripts/net01-e2e"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

say "停止本机 agent 进程（仅 net01 启动的）"
pkill -f "tunex-agent-net01 -s" 2>/dev/null || true
sleep 0.5

say "确认没有误伤其它栈"
echo "  relayx 栈: $(docker ps --format '{{.Names}}' | grep -c '^relayx-' || true) 个容器仍在运行"

say "拆除 net01 独立栈（容器 + 网络 + 数据卷）"
docker compose -f "$HERE/docker-compose.yaml" --env-file "$HERE/.env.net01" down -v --remove-orphans

say "清理运行期产物（保留脚本与文档）"
rm -rf /tmp/net01 /tmp/tunex-agent-net01
rm -f "$HERE/state.json" "$HERE/.passwords.env" "$HERE/_bootstrap.py" "$HERE/.env.net01"
rm -rf "$HERE/evidence"
# 若不再需要整栈密钥，可再删 .env.net01；此处一并删除以恢复「零痕迹」
echo "  已删除: state.json .passwords.env _bootstrap.py .env.net01 evidence/"

say "完成。net01 环境已完全销毁，不影响 relayx 与 TuneX 栈"
