#!/usr/bin/env bash
# TuneX real Integration setup.
set -euo pipefail

REPO=${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
HERE="$REPO/scripts/integration"
COMPOSE="$HERE/docker-compose.yaml"
ENVF="$HERE/.env.integration"
PASSF="$HERE/.passwords.env"
STATE="$HERE/state.json"
AGENT_ENV="$HERE/.agent.env"
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
JWT_ISSUER=integration
EOF
  chmod 600 "$ENVF"
  set -a; . "$ENVF"; set +a
fi
export DATABASE_URL
if [[ "${TUNEX_FXP_LINKS_ENABLED:-false}" == "true" && -z "${TUNEX_LINK_SEAL_KEY:-}" ]]; then
  # A disposable installation still needs one stable independent seal key across
  # Panel/Worker restarts. Write it only into the existing private test env file.
  TUNEX_LINK_SEAL_KEY="$(openssl rand -hex 32)"
  printf '\nTUNEX_LINK_SEAL_KEY=%s\n' "$TUNEX_LINK_SEAL_KEY" >> "$ENVF"
  chmod 600 "$ENVF"
  export TUNEX_LINK_SEAL_KEY
fi

if [[ -f "$PASSF" ]]; then
  set -a; . "$PASSF"; set +a
else
  umask 077
  TUNEX_IT_USER_PASSWORD="$(openssl rand -base64 30 | tr -d '\n')"
  printf 'TUNEX_IT_USER_PASSWORD=%q\n' "$TUNEX_IT_USER_PASSWORD" >"$PASSF"
  chmod 600 "$PASSF"
  export TUNEX_IT_USER_PASSWORD
fi

# ---------------------------------------------------------------- images
if [[ -z "${TUNEX_BACKEND_IMAGE:-}" ]]; then
  say "从当前 checkout 构建 Backend"
  docker build -t tunex-it-backend:ci "$REPO/backend"
  export TUNEX_BACKEND_IMAGE=tunex-it-backend:ci
fi
if [[ -z "${TUNEX_IT_AGENT_IMAGE:-}" ]]; then
  say "从当前 checkout 构建 Agent"
  docker build --build-arg "AGENT_VERSION=${TUNEX_IT_AGENT_VERSION:-unknown}" -t tunex-it-agent:ci -f "$REPO/agent/Dockerfile" "$REPO"
  export TUNEX_IT_AGENT_IMAGE=tunex-it-agent:ci
fi
echo "images: backend=$TUNEX_BACKEND_IMAGE agent=$TUNEX_IT_AGENT_IMAGE"

# Credentials are not known until provision phase. Defaults let Compose parse
# the whole file before Agents are started.
export TUNEX_IT_INGRESS_CREDENTIAL=${TUNEX_IT_INGRESS_CREDENTIAL:-UNPROVISIONED}
export TUNEX_IT_EGRESS_CREDENTIAL=${TUNEX_IT_EGRESS_CREDENTIAL:-UNPROVISIONED}
export TUNEX_IT_INGRESS_AGENT_ID=${TUNEX_IT_INGRESS_AGENT_ID:-UNPROVISIONED}
export TUNEX_IT_EGRESS_AGENT_ID=${TUNEX_IT_EGRESS_AGENT_ID:-UNPROVISIONED}
export TUNEX_IT_INGRESS_B_CREDENTIAL=${TUNEX_IT_INGRESS_B_CREDENTIAL:-UNPROVISIONED}
export TUNEX_IT_EGRESS_B_CREDENTIAL=${TUNEX_IT_EGRESS_B_CREDENTIAL:-UNPROVISIONED}
export TUNEX_IT_INGRESS_B_AGENT_ID=${TUNEX_IT_INGRESS_B_AGENT_ID:-UNPROVISIONED}
export TUNEX_IT_EGRESS_B_AGENT_ID=${TUNEX_IT_EGRESS_B_AGENT_ID:-UNPROVISIONED}

# Recreate networks so old Integration topology cannot leak into this regression. Keep DB
# volume for idempotent migration/provision coverage.
docker compose -f "$COMPOSE" --env-file "$ENVF" down --remove-orphans >/dev/null 2>&1 || true

# ---------------------------------------------------------------- data/control
say "启动 MySQL / Redis"
docker compose -f "$COMPOSE" --env-file "$ENVF" up -d mysql redis
for _ in $(seq 1 60); do
  m=$(docker inspect -f '{{.State.Health.Status}}' tunex-it-mysql 2>/dev/null || echo none)
  r=$(docker inspect -f '{{.State.Health.Status}}' tunex-it-redis 2>/dev/null || echo none)
  [[ "$m" == healthy && "$r" == healthy ]] && break
  sleep 2
done
[[ "$(docker inspect -f '{{.State.Health.Status}}' tunex-it-mysql)" == healthy ]] || die "MySQL 未 healthy"
[[ "$(docker inspect -f '{{.State.Health.Status}}' tunex-it-redis)" == healthy ]] || die "Redis 未 healthy"

say "执行 Prisma migrate + seed"
docker compose -f "$COMPOSE" --env-file "$ENVF" run --rm db-migrate

# baseline-F1 topology closure needs four concrete Nodes in the same team workspace.
# Production's free_team default remains max_nodes=2; only this disposable E2E DB
# raises the test entitlement so every Node can still be created through the real
# provisioning/enrollment API instead of bypassing quota/business logic.
say "E2E-only capability fixture：team node quota = 4"
docker exec tunex-it-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" -e "
  UPDATE capability_policy
  SET max_nodes=4, revision=revision+1
  WHERE applies_to='"'"'team'"'"' AND source='"'"'system_default'"'"' AND is_default=1;"'
quota=$(docker exec tunex-it-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" -N -e "
  SELECT IFNULL(max_nodes,0) FROM capability_policy
  WHERE applies_to='"'"'team'"'"' AND source='"'"'system_default'"'"' AND is_default=1
  ORDER BY id ASC LIMIT 1;"' | tail -1 | tr -d '\r')
[[ "$quota" == "4" ]] || die "E2E team node quota fixture 未生效（got=$quota）"

say "启动 Panel / Worker / Targets / Client"
docker compose -f "$COMPOSE" --env-file "$ENVF" up -d panel worker target-a target-b client
for _ in $(seq 1 60); do
  h=$(docker inspect -f '{{.State.Health.Status}}' tunex-it-panel 2>/dev/null || echo none)
  [[ "$h" == healthy ]] && break
  sleep 2
done
curl -fsS -m 5 "$API/healthz" >/dev/null || die "Panel /healthz 失败"

# ---------------------------------------------------------------- provision
say "阶段 1：workspace / groups / concrete Nodes / per-node credentials"
export API STATE TUNEX_IT_USER_PASSWORD
TUNEX_IT_BOOTSTRAP_PHASE=provision python3 "$HERE/bootstrap.py"

export TUNEX_IT_INGRESS_CREDENTIAL
export TUNEX_IT_EGRESS_CREDENTIAL
export TUNEX_IT_INGRESS_AGENT_ID
export TUNEX_IT_EGRESS_AGENT_ID
export TUNEX_IT_INGRESS_B_CREDENTIAL
export TUNEX_IT_EGRESS_B_CREDENTIAL
export TUNEX_IT_INGRESS_B_AGENT_ID
export TUNEX_IT_EGRESS_B_AGENT_ID
TUNEX_IT_INGRESS_CREDENTIAL=$(python3 -c "import json;print(json.load(open('$STATE'))['nodes']['ingress']['credential'])")
TUNEX_IT_EGRESS_CREDENTIAL=$(python3 -c "import json;print(json.load(open('$STATE'))['nodes']['egress']['credential'])")
TUNEX_IT_INGRESS_AGENT_ID=$(python3 -c "import json;print(json.load(open('$STATE'))['nodes']['ingress']['agent_id'])")
TUNEX_IT_EGRESS_AGENT_ID=$(python3 -c "import json;print(json.load(open('$STATE'))['nodes']['egress']['agent_id'])")
TUNEX_IT_INGRESS_B_CREDENTIAL=$(python3 -c "import json;print(json.load(open('$STATE'))['nodes']['ingress_secondary']['credential'])")
TUNEX_IT_EGRESS_B_CREDENTIAL=$(python3 -c "import json;print(json.load(open('$STATE'))['nodes']['egress_secondary']['credential'])")
TUNEX_IT_INGRESS_B_AGENT_ID=$(python3 -c "import json;print(json.load(open('$STATE'))['nodes']['ingress_secondary']['agent_id'])")
TUNEX_IT_EGRESS_B_AGENT_ID=$(python3 -c "import json;print(json.load(open('$STATE'))['nodes']['egress_secondary']['agent_id'])")

say "写入 Agent entrypoint 环境文件"
umask 077
cat >"$AGENT_ENV" <<'EOF'
# Integration keeps runtime configuration in CLI arguments.
# This file exists so source-built and candidate images exercise the production entrypoint.
EOF
chmod 600 "$AGENT_ENV"

say "启动四个 Agents（仅主动出站；admin port=0）"
docker compose -f "$COMPOSE" --env-file "$ENVF" up -d --force-recreate ingress-agent egress-agent ingress-agent-b egress-agent-b

# Wait until all four Agents authenticated with their per-node credentials.
say "等待四个 Agent state report"
for _ in $(seq 1 60); do
  count=$(docker exec tunex-it-mysql sh -c     'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" -N -e "
      SELECT COUNT(*) FROM node_state_report s
      JOIN node n ON n.id=s.node_id
      WHERE n.node_id IN ('"'"'Integration-IN-A-NODE'"'"','"'"'Integration-OUT-A-NODE'"'"','"'"'Integration-IN-C-NODE'"'"','"'"'Integration-OUT-B-NODE'"'"')
        AND s.reported_at > NOW() - INTERVAL 2 MINUTE;"' 2>/dev/null | tail -1 || echo 0)
  [[ "${count:-0}" -ge 4 ]] && break
  sleep 2
done
[[ "${count:-0}" -ge 4 ]] || {
  docker logs --tail 80 tunex-it-ingress-agent || true
  docker logs --tail 80 tunex-it-egress-agent || true
  docker logs --tail 80 tunex-it-ingress-agent-b || true
  docker logs --tail 80 tunex-it-egress-agent-b || true
  die "四个 Agent 未完成 credential-authenticated state report"
}

# ---------------------------------------------------------------- live creation
say "阶段 2：创建 DIRECT / RELAY（请求等待真实 Agent ACK）"
TUNEX_IT_BOOTSTRAP_PHASE=tunnels python3 "$HERE/bootstrap.py"

# ----------------------------------------------------------------
# Phase 3: create the baseline Forward object. The protocol regression above reuses the legacy
# /api/tunnels surface; the baseline Forward is the product entity the baseline scenarios
# edit, so it must exist with a real, ACKed runtime before any baseline scenario
# runs. It is the same tunnel row seen as a PortForward — no extra runtime,
# no extra Agent.
#
# Exactly ONE create call: `create_v4_forward` passes a fixed listen_port from
# the fixture, and a second call would hit 409 `port_conflict` (the first call
# already bound that port) and abort setup.sh before the topology checks run.
# Port occupancy inside the workspace is asserted by the API itself, not by
# repeating the request.
# ----------------------------------------------------------------
say "阶段 3：创建 baseline Forward（DIRECT，baseline 场景的被编辑对象）"
TUNEX_IT_BOOTSTRAP_PHASE=forward python3 "$HERE/bootstrap.py"

say "拓扑约束检查"
for c in tunex-it-panel tunex-it-worker tunex-it-ingress-agent tunex-it-egress-agent tunex-it-target-a tunex-it-target-b tunex-it-client; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" == true ]] || die "$c 未运行"
done
# No Agent management/data host ports.
for c in tunex-it-ingress-agent tunex-it-egress-agent; do
  ports=$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')
  [[ "$ports" == "{}" || "$ports" == "null" ]] || die "$c 意外暴露 host port: $ports"
  docker logs "$c" 2>&1 | grep -q "admin api listening" && die "$c 意外启动了 admin API"
done
# Panel must not join data networks.
panel_nets=$(docker inspect tunex-it-panel --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')
[[ "$panel_nets" != *"tunex_it_ingress_data"* && "$panel_nets" != *"tunex_it_egress_data"* ]] || die "Panel 意外接入数据网段"

say "环境就绪"
cat <<EOF
  panel       : $API
  control     : Agent -> Panel /api/internal/node/{commands,ack,state,desired}
  ingress     : 172.31.10.20 (data only)
  egress      : 172.31.20.20 (data only)
  Agent admin : disabled
  state       : $STATE

下一步： python3 $HERE/current-protocol.py
EOF
