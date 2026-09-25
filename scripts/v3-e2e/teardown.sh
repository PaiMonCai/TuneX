#!/usr/bin/env bash
# WP14 v3 E2E Harness —— 环境销毁（幂等，只动 wp14-* 自己的栈）
#
# 销毁范围（与 net01-e2e / tunex / relayx 三套栈完全隔离）：
#   · 容器 wp14-*（panel / mysql / redis / db-migrate / 两个 agent / 两个 target）
#   · 网络 wp14_ctrl / wp14_ingress_data / wp14_egress_data
#   · 数据卷 wp14_mysql_data
#   · 运行期产物：state.json / .env.wp14 / .passwords.env / evidence/ / agent.Dockerfile.e2e
#
# 保留（版本库内交付物）：docker-compose.e2e.yaml / setup.sh / verify.sh /
# _bootstrap.py / fixtures/ / README.md
#
# 镜像 wp14-agent:ci / wp14-backend:ci 默认保留（重跑 setup.sh 可秒起）；
# DELETE_IMAGES=1 时一并删除。
set -euo pipefail

REPO=${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
HERE="$REPO/scripts/v3-e2e"
ENVF="$HERE/.env.wp14"

# Compose validates required substitutions even for `down`. Load the generated
# E2E env first and provide harmless placeholders for runtime-only values.
if [[ -f "$ENVF" ]]; then
  set -a; . "$ENVF"; set +a
fi
export TUNEX_BACKEND_IMAGE=${TUNEX_BACKEND_IMAGE:-wp14-backend:ci}
export WP14_AGENT_IMAGE=${WP14_AGENT_IMAGE:-wp14-agent:ci}
export WP14_INGRESS_CREDENTIAL=${WP14_INGRESS_CREDENTIAL:-UNPROVISIONED}
export WP14_EGRESS_CREDENTIAL=${WP14_EGRESS_CREDENTIAL:-UNPROVISIONED}

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

say "确认没有误伤其它栈"
for prefix in net01- tunex- relayx-; do
  n=$(docker ps --format '{{.Names}}' | grep -c "^${prefix}" || true)
  echo "  ${prefix}*: $n 个容器仍在运行（本次操作不影响它们）"
done

say "拆除 wp14-e2e 栈（容器 + 网络 + 数据卷）"
docker compose -f "$HERE/docker-compose.e2e.yaml" --env-file "$ENVF" down -v --remove-orphans

# 兜底：个别 compose 版本在 --remove-orphans 下仍可能留下断网容器/网络
leftover=$(docker ps -a --format '{{.Names}}' | grep '^wp14-' || true)
[[ -z "$leftover" ]] || { echo "  清理残留容器: $leftover"; docker rm -f $leftover >/dev/null; }
for net in wp14_ctrl wp14_ingress_data wp14_egress_data; do
  if docker network inspect "$net" >/dev/null 2>&1; then
    echo "  清理残留网络: $net"; docker network rm "$net" >/dev/null 2>&1 || true
  fi
done

say "清理运行期产物（保留脚本、fixtures、_bootstrap.py、文档）"
rm -f "$HERE/state.json" "$HERE/.env.wp14" "$HERE/.passwords.env" \
      "$HERE/agent.Dockerfile.e2e"
rm -rf "$HERE/evidence"
echo "  已删除: state.json .env.wp14 .passwords.env agent.Dockerfile.e2e evidence/"
# _bootstrap.py 是版本库内交付物（setup.sh 调用），刻意不删。

if [[ "${DELETE_IMAGES:-}" == "1" ]]; then
  say "删除 CI 期构建的镜像（DELETE_IMAGES=1）"
  for img in wp14-backend:ci wp14-agent:ci; do
    docker image inspect "$img" >/dev/null 2>&1 && docker rmi "$img" >/dev/null \
      && echo "  已删除镜像 $img" || echo "  镜像不存在: $img"
  done
else
  say "保留 wp14-backend:ci / wp14-agent:ci 镜像（DELETE_IMAGES=1 可删）"
fi

say "完成。wp14-e2e 环境已销毁，不影响 net01 / tunex / relayx 栈"
