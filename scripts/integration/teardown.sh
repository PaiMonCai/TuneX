#!/usr/bin/env bash
# TuneX Integration topology teardown (idempotent).
#
# 销毁范围（与 net01-e2e / tunex / relayx 三套栈完全隔离）：
#   · 容器 tunex-it-*（panel / mysql / redis / db-migrate / 两个 agent / 两个 target）
#   · 网络 tunex_it_ctrl / tunex_it_ingress_data / tunex_it_egress_data
#   · 数据卷 tunex_it_mysql_data
#   · 运行期产物：state.json / .env.integration / .passwords.env / evidence/ / .agent.env
#
# 保留（版本库内交付物）：docker-compose.yaml / setup.sh / verify.sh /
# bootstrap.py / fixtures/ / README.md
#
# 镜像 tunex-it-agent:ci / tunex-it-backend:ci 默认保留（重跑 setup.sh 可秒起）；
# DELETE_IMAGES=1 时一并删除。
set -euo pipefail

REPO=${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
HERE="$REPO/scripts/integration"
ENVF="$HERE/.env.integration"

# Compose validates required substitutions even for `down`. Load the generated
# E2E env first and provide harmless placeholders for runtime-only values.
if [[ -f "$ENVF" ]]; then
  set -a; . "$ENVF"; set +a
fi
export TUNEX_BACKEND_IMAGE=${TUNEX_BACKEND_IMAGE:-tunex-it-backend:ci}
export TUNEX_IT_AGENT_IMAGE=${TUNEX_IT_AGENT_IMAGE:-tunex-it-agent:ci}
export TUNEX_IT_INGRESS_CREDENTIAL=${TUNEX_IT_INGRESS_CREDENTIAL:-UNPROVISIONED}
export TUNEX_IT_EGRESS_CREDENTIAL=${TUNEX_IT_EGRESS_CREDENTIAL:-UNPROVISIONED}
export TUNEX_IT_INGRESS_AGENT_ID=${TUNEX_IT_INGRESS_AGENT_ID:-UNPROVISIONED}
export TUNEX_IT_EGRESS_AGENT_ID=${TUNEX_IT_EGRESS_AGENT_ID:-UNPROVISIONED}
export TUNEX_IT_INGRESS_B_CREDENTIAL=${TUNEX_IT_INGRESS_B_CREDENTIAL:-UNPROVISIONED}
export TUNEX_IT_EGRESS_B_CREDENTIAL=${TUNEX_IT_EGRESS_B_CREDENTIAL:-UNPROVISIONED}
export TUNEX_IT_INGRESS_B_AGENT_ID=${TUNEX_IT_INGRESS_B_AGENT_ID:-UNPROVISIONED}
export TUNEX_IT_EGRESS_B_AGENT_ID=${TUNEX_IT_EGRESS_B_AGENT_ID:-UNPROVISIONED}

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

say "确认没有误伤其它栈"
for prefix in net01- tunex- relayx-; do
  n=$(docker ps --format '{{.Names}}' | grep -c "^${prefix}" || true)
  echo "  ${prefix}*: $n 个容器仍在运行（本次操作不影响它们）"
done

say "拆除 tunex-it-e2e 栈（容器 + 网络 + 数据卷）"
docker compose -f "$HERE/docker-compose.yaml" --env-file "$ENVF" down -v --remove-orphans

# 兜底：个别 compose 版本在 --remove-orphans 下仍可能留下断网容器/网络
leftover=$(docker ps -a --format '{{.Names}}' | grep '^tunex-it-' || true)
[[ -z "$leftover" ]] || { echo "  清理残留容器: $leftover"; docker rm -f $leftover >/dev/null; }
for net in tunex_it_ctrl tunex_it_ingress_data tunex_it_egress_data; do
  if docker network inspect "$net" >/dev/null 2>&1; then
    echo "  清理残留网络: $net"; docker network rm "$net" >/dev/null 2>&1 || true
  fi
done

say "清理运行期产物（保留脚本、fixtures、bootstrap.py、文档）"
rm -f "$HERE/state.json" "$HERE/.env.integration" "$HERE/.passwords.env" \
      "$HERE/.agent.env"
rm -rf "$HERE/evidence"
echo "  已删除: state.json .env.integration .passwords.env .agent.env evidence/"
# bootstrap.py 是版本库内交付物（setup.sh 调用），刻意不删。

if [[ "${DELETE_IMAGES:-}" == "1" ]]; then
  say "删除 CI 期构建的镜像（DELETE_IMAGES=1）"
  for img in tunex-it-backend:ci tunex-it-agent:ci; do
    docker image inspect "$img" >/dev/null 2>&1 && docker rmi "$img" >/dev/null \
      && echo "  已删除镜像 $img" || echo "  镜像不存在: $img"
  done
else
  say "保留 tunex-it-backend:ci / tunex-it-agent:ci 镜像（DELETE_IMAGES=1 可删）"
fi

say "完成。tunex-it-e2e 环境已销毁，不影响 net01 / tunex / relayx 栈"
