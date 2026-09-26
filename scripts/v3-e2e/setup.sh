#!/usr/bin/env bash
# TuneX v3 real E2E setup.
set -euo pipefail

REPO=${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
HERE="$REPO/scripts/v3-e2e"
COMPOSE="$HERE/docker-compose.e2e.yaml"
ENVF="$HERE/.env.wp14"
PASSF="$HERE/.passwords.env"
STATE="$HERE/state.json"
API=${API:-http://127.0.0.1:18180}

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mFATAL: %s\033[0m\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "缺少依赖: $1"; }

need docker
need python3
need openssl
cd "$REPO"

# ---------------------------------------------------------------- secrets
if [[ -f "$ENVF" ]]; then
  set -a; . "$ENVF"; set +a
else
  say "生成 E2E 独立服务密钥"
  gen() { openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'; }
  MYSQL_ROOT_PASSWORD="$(openssl rand -hex 24)"
  AUTH_SECRET="$(gen)"
  LICENSE_SECRET="$(gen)"
  TUNEX_CONFIG_KEY="$(gen)"
  TUNEX_LICENSE_KEY="$(gen)"
  umask 077
  cat >"$ENVF" <<EOF
MYSQL_ROOT_PASSWORD=$MYSQL_ROOT_PASSWORD
MYSQL_DATABASE=tunex
DATABASE_URL=mysql://root:${MYSQL_ROOT_PASSWORD}@mysql:3306/tunex
REDIS_URL=redis://redis:6379
AUTH_SECRET=$AUTH_SECRET
LICENSE_SECRET=$LICENSE_SECRET
TUNEX_CONFIG_KEY=$TUNEX_CONFIG_KEY
TUNEX_LICENSE_KEY=$TUNEX_LICENSE_KEY
JWT_ISSUER=wp14
EOF
  chmod 600 "$ENVF"
  set -a; . "$ENVF"; set +a
fi
export DATABASE_URL

if [[ -f "$PASSF" ]]; then
  set -a; . "$PASSF"; set +a
else
  umask 077
  WP14_USER_PASSWORD="$(openssl rand -base64 30 | tr -d '\n')"
  printf 'WP14_USER_PASSWORD=%q\n' "$WP14_USER_PASSWORD" >"$PASSF"
  chmod 600 "$PASSF"
  export WP14_USER_PASSWORD
fi

# ---------------------------------------------------------------- images
AGENT_DOCKERFILE="$HERE/agent.Dockerfile.e2e"
cat >"$AGENT_DOCKERFILE" <<'DOCKERFILE'
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -o /out/tunex-agent .
FROM busybox:1.36
COPY --from=build /out/tunex-agent /usr/local/bin/tunex-agent
ENTRYPOINT ["/usr/local/bin/tunex-agent"]
DOCKERFILE

if [[ -z "${TUNEX_BACKEND_IMAGE:-}" ]]; then
  say "从当前 checkout 构建 Backend"
  docker build -t wp14-backend:ci "$REPO/backend"
  export TUNEX_BACKEND_IMAGE=wp14-backend:ci
fi
if [[ -z "${WP14_AGENT_IMAGE:-}" ]]; then
  say "从当前 checkout 构建 Agent"
  docker build -t wp14-agent:ci -f "$AGENT_DOCKERFILE" "$REPO/agent"
  export WP14_AGENT_IMAGE=wp14-agent:ci
fi
echo "images: backend=$TUNEX_BACKEND_IMAGE agent=$WP14_AGENT_IMAGE"

# Credentials are not known until provision phase. Defaults let Compose parse
# the whole file before Agents are started.
export WP14_INGRESS_CREDENTIAL=${WP14_INGRESS_CREDENTIAL:-UNPROVISIONED}
export WP14_EGRESS_CREDENTIAL=${WP14_EGRESS_CREDENTIAL:-UNPROVISIONED}
export WP14_INGRESS_AGENT_ID=${WP14_INGRESS_AGENT_ID:-UNPROVISIONED}
export WP14_EGRESS_AGENT_ID=${WP14_EGRESS_AGENT_ID:-UNPROVISIONED}

# Recreate networks so old WP14 topology cannot leak into this gate. Keep DB
# volume for idempotent migration/provision coverage.
docker compose -f "$COMPOSE" --env-file "$ENVF" down --remove-orphans >/dev/null 2>&1 || true

# ---------------------------------------------------------------- data/control
say "启动 MySQL / Redis"
docker compose -f "$COMPOSE" --env-file "$ENVF" up -d mysql redis
for _ in $(seq 1 60); do
  m=$(docker inspect -f '{{.State.Health.Status}}' wp14-mysql 2>/dev/null || echo none)
  r=$(docker inspect -f '{{.State.Health.Status}}' wp14-redis 2>/dev/null || echo none)
  [[ "$m" == healthy && "$r" == healthy ]] && break
  sleep 2
done
[[ "$(docker inspect -f '{{.State.Health.Status}}' wp14-mysql)" == healthy ]] || die "MySQL 未 healthy"
[[ "$(docker inspect -f '{{.State.Health.Status}}' wp14-redis)" == healthy ]] || die "Redis 未 healthy"

say "执行 Prisma migrate + seed"
docker compose -f "$COMPOSE" --env-file "$ENVF" run --rm db-migrate

say "启动 Panel / Worker / Targets / Client"
docker compose -f "$COMPOSE" --env-file "$ENVF" up -d panel worker target-a target-b client
for _ in $(seq 1 60); do
  h=$(docker inspect -f '{{.State.Health.Status}}' wp14-panel 2>/dev/null || echo none)
  [[ "$h" == healthy ]] && break
  sleep 2
done
curl -fsS -m 5 "$API/healthz" >/dev/null || die "Panel /healthz 失败"

# ---------------------------------------------------------------- provision
say "阶段 1：workspace / groups / concrete Nodes / per-node credentials"
export API STATE WP14_USER_PASSWORD
WP14_BOOTSTRAP_PHASE=provision python3 "$HERE/_bootstrap.py"

export WP14_INGRESS_CREDENTIAL
export WP14_EGRESS_CREDENTIAL
export WP14_INGRESS_AGENT_ID
export WP14_EGRESS_AGENT_ID
WP14_INGRESS_CREDENTIAL=$(python3 -c "import json;print(json.load(open('$STATE'))['nodes']['ingress']['credential'])")
WP14_EGRESS_CREDENTIAL=$(python3 -c "import json;print(json.load(open('$STATE'))['nodes']['egress']['credential'])")
WP14_INGRESS_AGENT_ID=$(python3 -c "import json;print(json.load(open('$STATE'))['nodes']['ingress']['agent_id'])")
WP14_EGRESS_AGENT_ID=$(python3 -c "import json;print(json.load(open('$STATE'))['nodes']['egress']['agent_id'])")

say "启动 Agents（仅主动出站；admin port=0）"
docker compose -f "$COMPOSE" --env-file "$ENVF" up -d --force-recreate ingress-agent egress-agent

# Wait until both Agents authenticated with their per-node credentials and
# produced a DB state report. This proves Agent -> Panel before tunnel creation.
say "等待两个 Agent state report"
for _ in $(seq 1 45); do
  count=$(docker exec wp14-mysql sh -c     'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" -N -e "
      SELECT COUNT(*) FROM node_state_report s
      JOIN node n ON n.id=s.node_id
      WHERE n.node_id IN ('"'"'WP14-IN-A-NODE'"'"','"'"'WP14-OUT-A-NODE'"'"')
        AND s.reported_at > NOW() - INTERVAL 2 MINUTE;"' 2>/dev/null | tail -1 || echo 0)
  [[ "${count:-0}" -ge 2 ]] && break
  sleep 2
done
[[ "${count:-0}" -ge 2 ]] || {
  docker logs --tail 80 wp14-ingress-agent || true
  docker logs --tail 80 wp14-egress-agent || true
  die "Agent 未完成 credential-authenticated state report"
}

# ---------------------------------------------------------------- live creation
say "阶段 2：创建 DIRECT / RELAY（请求等待真实 Agent ACK）"
WP14_BOOTSTRAP_PHASE=tunnels python3 "$HERE/_bootstrap.py"

# ----------------------------------------------------------------
# Phase 3: create the V4 Forward object. The v3 gate above reuses the legacy
# /api/tunnels surface; the V4 Forward is the product entity the V4 scenarios
# edit, so it must exist with a real, ACKed runtime before any V4 scenario
# runs. It is the same tunnel row seen as a PortForward — no extra runtime,
# no extra Agent.
# ----------------------------------------------------------------
say "阶段 3：创建 V4 Forward（DIRECT，V4 场景的被编辑对象）"
WP14_BOOTSTRAP_PHASE=forward python3 "$HERE/_bootstrap.py"

say "拓扑约束检查"
for c in wp14-panel wp14-worker wp14-ingress-agent wp14-egress-agent wp14-target-a wp14-target-b wp14-client; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]] || die "$c 未运行"
done
# No Agent management/data host ports.
for c in wp14-ingress-agent wp14-egress-agent; do
  ports=$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')
  [[ "$ports" == "{}" || "$ports" == "null" ]] || die "$c 意外暴露 host port: $ports"
  docker logs "$c" 2>&1 | grep -q "v3 admin api listening" && die "$c 意外启动了 admin API"
done
# Panel must not join data networks.
panel_nets=$(docker inspect wp14-panel --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')
[[ "$panel_nets" != *"wp14_ingress_data"* && "$panel_nets" != *"wp14_egress_data"* ]] || die "Panel 意外接入数据网段"

# ---------------------------------------------------------------- V4 forward object
# The v3 gate keeps using the legacy /api/tunnels surface. The V4 Forward object
# is the product entity going forward, so create it too (real HTTP + real ACK):
# it is what the V4 scenarios edit. It reuses the same tunnel row seen as a
# PortForward, so no extra runtime or Agent is introduced.
say "阶段 3：创建 V4 Forward（DIRECT，作为 V4 场景的被编辑对象）"
WP14_BOOTSTRAP_PHASE=forward python3 "$HERE/_bootstrap.py"

say "环境就绪"
cat <<EOF
  panel       : $API
  control     : Agent -> Panel /api/internal/node/{commands,ack,state,desired}
  ingress     : 172.31.10.20 (data only)
  egress      : 172.31.20.20 (data only)
  Agent admin : disabled
  state       : $STATE

下一步： bash $HERE/verify.sh
EOF
