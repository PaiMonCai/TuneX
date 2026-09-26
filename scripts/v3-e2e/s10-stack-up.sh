#!/usr/bin/env bash
# Rebuild the wp14 E2E stack on prebuilt exact-SHA GHCR images.
#
# This is a harness bootstrap (equivalent to setup.sh's stack bring-up, minus the
# docker build steps) and does NOT produce gate evidence by itself. It deletes
# only wp14-* containers and then provisions from scratch through the real HTTP
# API by reusing the existing _bootstrap.py provisioning phases.
#
# Usage: PREBUILT=1 bash scripts/v3-e2e/s10-stack-up.sh
set -euo pipefail

REPO=${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
HERE="$REPO/scripts/v3-e2e"
COMPOSE="$HERE/docker-compose.e2e.yaml"
COMPOSE_S10="$HERE/docker-compose.e2e-s10.yaml"
ENVF="$HERE/.env.wp14"
PASSF="$HERE/.passwords.env"
STATE="$HERE/state.json"
API=${API:-http://127.0.0.1:18180}
HEAD_SHA=${HEAD_SHA:-ed23e550e3584eccca58068f22643ae8acb90997}
BACKEND_IMAGE=${TUNEX_BACKEND_IMAGE:-ghcr.io/paimoncai/tunex:$HEAD_SHA}
AGENT_IMAGE=${WP14_AGENT_IMAGE:-ghcr.io/paimoncai/tunex-agent:$HEAD_SHA}
ALLOWED="wp14-panel wp14-worker wp14-mysql wp14-redis wp14-db-migrate wp14-ingress-agent wp14-egress-agent wp14-target-a wp14-target-b wp14-client"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mFATAL: %s\033[0m\n' "$*" >&2; exit 1; }

[[ -f "$ENVF"  ]] || die "missing $ENVF"
[[ -f "$PASSF" ]] || die "missing $PASSF"
set -a; . "$ENVF"; set +a
set -a; . "$PASSF"; set +a
export DATABASE_URL

# images must be present locally (pulled earlier, no build in this slice)
for img in "$BACKEND_IMAGE" "$AGENT_IMAGE"; do
  docker image inspect "$img" >/dev/null 2>&1 || die "本地缺少预构建镜像 $img"
  echo "image: $img ($(docker image inspect -f '{{.Id}}' "$img" | cut -c8-19))"
done

# Scope guard: never touch non-wp14 containers.
for c in $(docker ps -a --format '{{.Names}}'); do
  case "$c" in wp14-*) ;; *) continue;; esac
  [[ " $ALLOWED " == *" $c "* ]] || die "$c 形似 wp14-* 但不在白名单内"
done

export TUNEX_BACKEND_IMAGE="$BACKEND_IMAGE"
export WP14_AGENT_IMAGE="$AGENT_IMAGE"
# Compose parses the whole file before Agents are started, so the per-node
# credentials need defaults exactly like setup.sh does.
export WP14_INGRESS_CREDENTIAL=${WP14_INGRESS_CREDENTIAL:-UNPROVISIONED}
export WP14_EGRESS_CREDENTIAL=${WP14_EGRESS_CREDENTIAL:-UNPROVISIONED}
export WP14_INGRESS_AGENT_ID=${WP14_INGRESS_AGENT_ID:-UNPROVISIONED}
export WP14_EGRESS_AGENT_ID=${WP14_EGRESS_AGENT_ID:-UNPROVISIONED}
CMP=(docker compose -f "$COMPOSE" -f "$COMPOSE_S10" --env-file "$ENVF")

say "拆除旧 wp14 栈（仅 wp14-*）"
"${CMP[@]}" down --remove-orphans >/dev/null 2>&1 || true
for c in $(docker ps -a --format '{{.Names}}' | grep '^wp14-' || true); do
  [[ " $ALLOWED " == *" $c "* ]] || die "$c 不在白名单内，拒绝触碰"
done

say "启动 MySQL / Redis"
"${CMP[@]}" up -d mysql redis
for _ in $(seq 1 60); do
  m=$(docker inspect -f '{{.State.Health.Status}}' wp14-mysql 2>/dev/null || echo none)
  r=$(docker inspect -f '{{.State.Health.Status}}' wp14-redis 2>/dev/null || echo none)
  [[ "$m" == healthy && "$r" == healthy ]] && break
  sleep 2
done
[[ "$(docker inspect -f '{{.State.Health.Status}}' wp14-mysql)" == healthy ]] || die "MySQL 未 healthy"
[[ "$(docker inspect -f '{{.State.Health.Status}}' wp14-redis)" == healthy ]] || die "Redis 未 healthy"

say "migrate + seed（镜像内运行，非本地 build）"
"${CMP[@]}" run --rm db-migrate >/dev/null

say "启动 Panel / Worker / Targets / Client"
"${CMP[@]}" up -d panel worker target-a target-b client
for _ in $(seq 1 60); do
  h=$(docker inspect -f '{{.State.Health.Status}}' wp14-panel 2>/dev/null || echo none)
  [[ "$h" == healthy ]] && break
  sleep 2
done
[[ "$(docker inspect -f '{{.State.Health.Status}}' wp14-panel)" == healthy ]] || die "Panel 未 healthy"
curl -fsS -m 5 "$API/healthz" >/dev/null || die "Panel /healthz 失败"
echo "panel ok on $API"

say "provisioning（复用 _bootstrap.py，真实 HTTP API）"
export API STATE WP14_USER_PASSWORD
WP14_BOOTSTRAP_PHASE=provision python3 "$HERE/_bootstrap.py" >/dev/null

export WP14_INGRESS_CREDENTIAL WP14_EGRESS_CREDENTIAL WP14_INGRESS_AGENT_ID WP14_EGRESS_AGENT_ID
WP14_INGRESS_CREDENTIAL=$(python3 -c "import json;print(json.load(open('$STATE'))['nodes']['ingress']['credential'])")
WP14_EGRESS_CREDENTIAL=$(python3 -c "import json;print(json.load(open('$STATE'))['nodes']['egress']['credential'])")
WP14_INGRESS_AGENT_ID=$(python3 -c "import json;print(json.load(open('$STATE'))['nodes']['ingress']['agent_id'])")
WP14_EGRESS_AGENT_ID=$(python3 -c "import json;print(json.load(open('$STATE'))['nodes']['egress']['agent_id'])")

say "启动 Agents（exact-SHA 预构建镜像，entrypoint 直连二进制）"
"${CMP[@]}" up -d --force-recreate ingress-agent egress-agent

say "等待两个 Agent state report"
count=0
for _ in $(seq 1 60); do
  count=$(docker exec wp14-mysql sh -c \
    "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" -N -e \
     \"SELECT COUNT(*) FROM tunex.node_state_report s JOIN tunex.node n ON n.id=s.node_id WHERE n.node_id IN ('WP14-IN-A-NODE','WP14-OUT-A-NODE') AND s.reported_at > NOW() - INTERVAL 2 MINUTE;\"" \
    2>/dev/null | tail -1 | tr -d '[:space:]')
  [[ "${count:-0}" -ge 2 ]] && break
  sleep 2
done
[[ "${count:-0}" -ge 2 ]] || {
  docker logs --tail 60 wp14-ingress-agent || true
  docker logs --tail 60 wp14-egress-agent || true
  die "Agent 未完成 state report (count=$count)"
}

say "创建 v3 DIRECT / RELAY 与 V4 Forward（真实 API，等待 Agent ACK）"
WP14_BOOTSTRAP_PHASE=tunnels python3 "$HERE/_bootstrap.py" >/dev/null
WP14_BOOTSTRAP_PHASE=forward python3 "$HERE/_bootstrap.py" >/dev/null

say "拓扑约束检查"
for c in wp14-panel wp14-worker wp14-ingress-agent wp14-egress-agent wp14-target-a wp14-target-b wp14-client; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]] || die "$c 未运行"
done
for c in wp14-ingress-agent wp14-egress-agent; do
  ports=$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')
  [[ "$ports" == "{}" || "$ports" == "null" ]] || die "$c 意外暴露 host port"
done
say "环境就绪（exact-SHA 镜像栈）"
docker ps --filter 'name=wp14-' --format '  {{.Names}}\t{{.Image}}\t{{.Status}}'