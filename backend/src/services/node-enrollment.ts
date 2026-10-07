import { createHash, randomBytes } from "node:crypto";
import { db } from "../db.ts";
import { env } from "../env.ts";
import { generateNodeCredential, hashNodeCredential } from "./node-credential.ts";

export const NODE_ENROLLMENT_TTL_SECONDS = 10 * 60;
export const NODE_ENROLLMENT_BYTES = 32;

export interface NodeEnrollmentIssued {
  token: string;
  node_id: number;
  node_key: string;
  agent_id: string;
  expires_at: string;
  install_command: string;
}

export interface EnrolledNode {
  credential: string;
  node_id: number;
  node_key: string;
  agent_id: string;
}

export class NodeEnrollmentError extends Error {
  constructor(
    public code: "node_not_found" | "invalid_enrollment",
    public status: 404 | 401,
  ) {
    super(code);
    this.name = "NodeEnrollmentError";
  }
}

export function generateNodeEnrollmentToken(): string {
  return randomBytes(NODE_ENROLLMENT_BYTES).toString("base64url");
}

export function hashNodeEnrollmentToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function normalizedPanelUrl(): string {
  return env.siteUrl.replace(/\/+$/, "");
}

function roleFlag(role: "ingress" | "egress" | "both" | null): string {
  if (role === "ingress") return "INGRESS";
  if (role === "egress") return "EGRESS";
  return "BOTH";
}

function rangeValue(min: number | null, max: number | null): string | null {
  if (min == null || max == null) return null;
  return `${min}-${max}`;
}

function buildInstallCommand(node: {
  node_id: string;
  agent_id: string;
  role: "ingress" | "egress" | "both" | null;
  port_range_min: number | null;
  port_range_max: number | null;
}, token: string): string {
  const panel = normalizedPanelUrl();
  const range = rangeValue(node.port_range_min, node.port_range_max);
  const args = [
    "--panel", shellQuote(panel),
    "--enroll-token", shellQuote(token),
    "--agent-image", shellQuote(env.agentImage),
    "--agent-id", shellQuote(node.agent_id),
    "--node-id", shellQuote(node.node_id),
    "--role", shellQuote(roleFlag(node.role)),
  ];
  if (range && (node.role === "ingress" || node.role === "both" || node.role === null)) {
    args.push("--ingress-range", shellQuote(range));
  }
  if (range && (node.role === "egress" || node.role === "both" || node.role === null)) {
    args.push("--egress-range", shellQuote(range));
  }
  return `curl -fsSL ${shellQuote(`${panel}/api/internal/node/install.sh`)} | sudo sh -s -- ${args.join(" ")}`;
}

/**
 * Re-issuing an installer intentionally revokes every still-unused enrollment
 * for the same node. The long-lived node credential is not touched until the
 * new token is actually consumed on the node.
 */
export async function createNodeEnrollment(
  nodeDbId: number,
  ttlSeconds = NODE_ENROLLMENT_TTL_SECONDS,
): Promise<NodeEnrollmentIssued> {
  const node = await db.node.findUnique({
    where: { id: nodeDbId },
    select: {
      id: true,
      node_id: true,
      agent_id: true,
      role: true,
      port_range_min: true,
      port_range_max: true,
    },
  });
  if (!node) throw new NodeEnrollmentError("node_not_found", 404);

  const plaintext = generateNodeEnrollmentToken();
  const tokenHash = hashNodeEnrollmentToken(plaintext);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + Math.max(60, ttlSeconds) * 1000);

  await db.$transaction(async (tx) => {
    await tx.nodeEnrollment.updateMany({
      where: { node_id: nodeDbId, used_at: null, revoked_at: null },
      data: { revoked_at: now },
    });
    await tx.nodeEnrollment.create({
      data: {
        node_id: nodeDbId,
        token_hash: tokenHash,
        expires_at: expiresAt,
      },
    });
  });

  return {
    token: plaintext,
    node_id: node.id,
    node_key: node.node_id,
    agent_id: node.agent_id,
    expires_at: expiresAt.toISOString(),
    install_command: buildInstallCommand(node, plaintext),
  };
}

/**
 * Consume one enrollment exactly once and mint the real per-node credential.
 * The token is claimed with updateMany guards inside the same transaction, so
 * concurrent requests cannot both succeed.
 */
export async function consumeNodeEnrollment(
  plaintext: string,
  observedIp?: string | null,
): Promise<EnrolledNode> {
  const tokenHash = hashNodeEnrollmentToken(plaintext);
  const now = new Date();
  const credential = generateNodeCredential();
  const credentialHash = hashNodeCredential(credential);

  const result = await db.$transaction(async (tx) => {
    const enrollment = await tx.nodeEnrollment.findUnique({
      where: { token_hash: tokenHash },
      select: {
        id: true,
        node_id: true,
        expires_at: true,
        used_at: true,
        revoked_at: true,
        node: { select: { node_id: true, agent_id: true, connect_ip: true } },
      },
    });
    if (
      !enrollment ||
      enrollment.used_at !== null ||
      enrollment.revoked_at !== null ||
      enrollment.expires_at.getTime() <= now.getTime()
    ) {
      return null;
    }

    const claimed = await tx.nodeEnrollment.updateMany({
      where: {
        id: enrollment.id,
        used_at: null,
        revoked_at: null,
        expires_at: { gt: now },
      },
      data: { used_at: now },
    });
    if (claimed.count !== 1) return null;

    await tx.node.update({
      where: { id: enrollment.node_id },
      data: {
        ...(!enrollment.node.connect_ip && observedIp ? { connect_ip: observedIp } : {}),
        node_credential_hash: credentialHash,
        credential_revoked: false,
        credential_rotated_at: now,
        credential_last_rejected_at: null,
      },
    });

    // Defense in depth: a consumed installer invalidates any older installer
    // that might have been generated before this request won the race.
    await tx.nodeEnrollment.updateMany({
      where: {
        node_id: enrollment.node_id,
        id: { not: enrollment.id },
        used_at: null,
        revoked_at: null,
      },
      data: { revoked_at: now },
    });

    return { id: enrollment.node_id, key: enrollment.node.node_id, agentID: enrollment.node.agent_id };
  });

  if (!result) throw new NodeEnrollmentError("invalid_enrollment", 401);
  return { credential, node_id: result.id, node_key: result.key, agent_id: result.agentID };
}

export function extractEnrollmentToken(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  const match = /^Enrollment\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() || null;
}

/**
 * Docker-first installer served by the Panel.
 *
 * The host script installs Docker Engine when missing, pulls the configured
 * slim Agent image before consuming enrollment, then stores the long-lived
 * credential in a root-only host file. The container only gets a read-only
 * bind mount of that file, so docker inspect does not expose the credential.
 */
/**
 * V5-WP21（Lead 裁决）：节点引导脚本**钉住**的 Docker Engine 版本。
 *
 * 为什么是常量而不是"最新"：`get.docker.com` 是一份**会变的**脚本（拿不到稳定校验和），
 * 而让一台生产节点今天装 27、明天装 28，会把"Agent 起不来"变成一次与本次安装无关的考古。
 * 升级这个值是**有意识的动作**：改这一行、跑一次针对引导脚本的断言。
 */
export const NODE_BOOTSTRAP_DOCKER_VERSION = "27.5.1";

export function renderNodeInstallScript(): string {
  return `#!/bin/sh
set -eu

PANEL=""
TOKEN=""
AGENT_IMAGE=""
AGENT_ID=""
NODE_ID=""
ROLE="BOTH"
INGRESS_RANGE=""
EGRESS_RANGE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --panel) PANEL="$2"; shift 2 ;;
    --enroll-token) TOKEN="$2"; shift 2 ;;
    --agent-image) AGENT_IMAGE="$2"; shift 2 ;;
    --agent-id) AGENT_ID="$2"; shift 2 ;;
    --node-id) NODE_ID="$2"; shift 2 ;;
    --role) ROLE="$2"; shift 2 ;;
    --ingress-range) INGRESS_RANGE="$2"; shift 2 ;;
    --egress-range) EGRESS_RANGE="$2"; shift 2 ;;
    *) echo "tunex install: unknown argument $1" >&2; exit 2 ;;
  esac
done

[ -n "$PANEL" ] || { echo "tunex install: --panel is required" >&2; exit 2; }
[ -n "$TOKEN" ] || { echo "tunex install: --enroll-token is required" >&2; exit 2; }
[ -n "$AGENT_IMAGE" ] || { echo "tunex install: --agent-image is required" >&2; exit 2; }
[ -n "$AGENT_ID" ] || { echo "tunex install: --agent-id is required" >&2; exit 2; }
[ -n "$NODE_ID" ] || { echo "tunex install: --node-id is required" >&2; exit 2; }

case "$(uname -s)" in
  Linux) ;;
  *) echo "tunex install: only Linux is supported" >&2; exit 3 ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  # V5-WP21（Lead 裁决）：**钉住版本**，不要"curl 到最新"。
  #
  # 为什么：get.docker.com 是一份**会变的**脚本，我们既不能对它做校验和（内容随上游变化），
  # 也不该让一台生产节点今天装 27、明天装 28 —— 版本漂移会把"Agent 起不来"变成一次
  # 与本次安装毫无关系的考古。钉版本之后，行为是确定的；失败也**可见**（下方显式报错），
  # 而不是静默装上一个我们没验证过的版本。
  #
  # 更保守的路径（离线/受限环境）见 docs/production-deploy.md：用发行版包管理器安装。
  DOCKER_PIN="${NODE_BOOTSTRAP_DOCKER_VERSION}"
  echo "TuneX: Docker Engine not found; installing pinned $DOCKER_PIN via get.docker.com..."
  TMP_DOCKER="$(mktemp)"
  trap 'rm -f "$TMP_DOCKER"' EXIT INT TERM
  curl -fsSL https://get.docker.com -o "$TMP_DOCKER"
  if ! sh "$TMP_DOCKER" --version "$DOCKER_PIN"; then
    echo "TuneX: 安装 Docker $DOCKER_PIN 失败（该版本可能不支持本发行版）；本脚本**不**回落到安装最新版" >&2
    echo "TuneX: 请手动安装 Docker $DOCKER_PIN 或更新版本的 Engine，然后重新运行本脚本" >&2
    exit 4
  fi
  rm -f "$TMP_DOCKER"
  trap - EXIT INT TERM
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl enable --now docker >/dev/null 2>&1 || true
fi

docker info >/dev/null 2>&1 || {
  echo "tunex install: Docker daemon is not available" >&2
  exit 4
}

# Multi-instance host layout. agent_id is Panel-generated, stable and unique;
# it is therefore the instance key for container name + host credential/state.
case "$AGENT_ID" in
  ""|*[!A-Za-z0-9._-]*)
    echo "tunex install: agent_id contains unsupported characters" >&2
    exit 2
    ;;
esac
[ "${#AGENT_ID}" -le 64 ] || { echo "tunex install: agent_id is too long" >&2; exit 2; }

CONTAINER="tunex-agent-$AGENT_ID"
INSTANCE_ENV_DIR="/etc/tunex-agent/instances/$AGENT_ID"
ENV_FILE="$INSTANCE_ENV_DIR/agent.env"
INSTANCE_STATE_DIR="/var/lib/tunex-agent/instances/$AGENT_ID"
LEGACY_CONTAINER="tunex-agent"
LEGACY_ENV_FILE="/etc/tunex-agent/agent.env"
LEGACY_STATE_DIR="/var/lib/tunex-agent"
LEGACY_SELF=0

read_env_value() {
  # Do not source an old env file: it is host-owned state, not executable code.
  sed -n "s/^$1=//p" "$2" 2>/dev/null | tail -n 1
}

ranges_overlap() {
  # return 0 = overlap, 1 = no overlap/empty, 2 = malformed
  [ -n "$1" ] && [ -n "$2" ] || return 1
  A_MIN="$(printf '%s' "$1" | cut -d- -f1)"
  A_MAX="$(printf '%s' "$1" | cut -d- -f2)"
  B_MIN="$(printf '%s' "$2" | cut -d- -f1)"
  B_MAX="$(printf '%s' "$2" | cut -d- -f2)"
  case "$A_MIN:$A_MAX:$B_MIN:$B_MAX" in
    *[!0-9:]*|*::*)
      return 2
      ;;
  esac
  [ "$A_MIN" -le "$A_MAX" ] && [ "$B_MIN" -le "$B_MAX" ] || return 2
  [ "$A_MIN" -le "$B_MAX" ] && [ "$B_MIN" -le "$A_MAX" ]
}

check_instance_ranges() {
  OTHER_NAME="$1"
  OTHER_AGENT="$2"
  OTHER_INGRESS="$3"
  OTHER_EGRESS="$4"

  [ "$OTHER_AGENT" = "$AGENT_ID" ] && return 0
  for WANT in "$INGRESS_RANGE" "$EGRESS_RANGE"; do
    [ -n "$WANT" ] || continue
    for HAVE in "$OTHER_INGRESS" "$OTHER_EGRESS"; do
      [ -n "$HAVE" ] || continue
      if ranges_overlap "$WANT" "$HAVE"; then
        echo "tunex install: port range $WANT overlaps existing TuneX Agent $OTHER_NAME ($OTHER_AGENT) range $HAVE" >&2
        echo "tunex install: assign disjoint ingress/egress ranges before installing multiple Agents on one host" >&2
        exit 6
      else
        RC="$?"
        [ "$RC" -ne 2 ] || {
          echo "tunex install: cannot validate existing Agent $OTHER_NAME port range $HAVE" >&2
          exit 6
        }
      fi
    done
  done
}

# New-layout instances publish their identity + allocation ranges as Docker labels.
# Include stopped containers too: a stopped Agent can be started later and must not
# be allowed to collide with a newly installed sibling.
for OTHER in $(docker ps -a --filter "label=io.tunex.agent=true" --format '{{.Names}}'); do
  OTHER_AGENT="$(docker inspect --format '{{ index .Config.Labels "io.tunex.agent-id" }}' "$OTHER" 2>/dev/null || true)"
  OTHER_INGRESS="$(docker inspect --format '{{ index .Config.Labels "io.tunex.ingress-range" }}' "$OTHER" 2>/dev/null || true)"
  OTHER_EGRESS="$(docker inspect --format '{{ index .Config.Labels "io.tunex.egress-range" }}' "$OTHER" 2>/dev/null || true)"
  check_instance_ranges "$OTHER" "$OTHER_AGENT" "$OTHER_INGRESS" "$OTHER_EGRESS"
done

# Backward compatibility: old TuneX used one global container/env/state path and
# had no labels. If that legacy instance is THIS agent we migrate its two durable
# state files and replace only it. If it belongs to ANOTHER agent, include its
# ranges in the same collision check and never delete/overwrite it.
if docker inspect "$LEGACY_CONTAINER" >/dev/null 2>&1 && [ -f "$LEGACY_ENV_FILE" ]; then
  LEGACY_AGENT_ID="$(read_env_value TUNEX_AGENT_ID "$LEGACY_ENV_FILE")"
  if [ "$LEGACY_AGENT_ID" = "$AGENT_ID" ]; then
    LEGACY_SELF=1
  elif [ -n "$LEGACY_AGENT_ID" ]; then
    LEGACY_INGRESS="$(read_env_value TUNEX_INGRESS_RANGE "$LEGACY_ENV_FILE")"
    LEGACY_EGRESS="$(read_env_value TUNEX_EGRESS_RANGE "$LEGACY_ENV_FILE")"
    if [ -z "$LEGACY_INGRESS" ] && [ -z "$LEGACY_EGRESS" ]; then
      echo "tunex install: legacy Agent $LEGACY_AGENT_ID is running but has no discoverable port ranges" >&2
      echo "tunex install: reinstall/upgrade that legacy Agent first, then add another instance" >&2
      exit 6
    fi
    check_instance_ranges "$LEGACY_CONTAINER" "$LEGACY_AGENT_ID" "$LEGACY_INGRESS" "$LEGACY_EGRESS"
  else
    echo "tunex install: legacy tunex-agent exists but its agent_id cannot be identified" >&2
    echo "tunex install: refusing to install a second Agent until the legacy instance is repaired/reinstalled" >&2
    exit 6
  fi
fi

# Pull first so a registry/network error does not consume the one-time token.
echo "TuneX: pulling Agent image $AGENT_IMAGE ..."
docker pull "$AGENT_IMAGE"

CREDENTIAL="$(curl -fsS -X POST \
  -H "Authorization: Enrollment $TOKEN" \
  -H "Accept: text/plain" \
  "$PANEL/api/internal/node/enroll")"
[ -n "$CREDENTIAL" ] || { echo "tunex install: enrollment returned an empty credential" >&2; exit 5; }

install -d -m 0700 /etc/tunex-agent /etc/tunex-agent/instances "$INSTANCE_ENV_DIR"
# Each Agent instance gets a different host state directory. Inside the container
# the path remains /var/lib/tunex-agent, so the Agent binary itself stays
# single-identity and needs no multi-tenant state model.
install -d -m 0700 /var/lib/tunex-agent /var/lib/tunex-agent/instances "$INSTANCE_STATE_DIR"

# One-time migration for an Agent installed before multi-instance support.
# Copy only the two durable Agent files; never recursively copy the new
# instances/ subtree into itself.
if [ "$LEGACY_SELF" -eq 1 ]; then
  for STATE_FILE in desired-lkg.json ownership-epoch.json; do
    if [ -f "$LEGACY_STATE_DIR/$STATE_FILE" ] && [ ! -e "$INSTANCE_STATE_DIR/$STATE_FILE" ]; then
      cp -p "$LEGACY_STATE_DIR/$STATE_FILE" "$INSTANCE_STATE_DIR/$STATE_FILE"
    fi
  done
fi

{
  printf '%s\n' "TUNEX_PANEL_HTTP_URL=$PANEL"
  printf '%s\n' "TUNEX_AGENT_ID=$AGENT_ID"
  printf '%s\n' "TUNEX_NODE_ID=$NODE_ID"
  printf '%s\n' "TUNEX_NODE_CREDENTIAL=$CREDENTIAL"
  printf '%s\n' "TUNEX_ROLE=$ROLE"
  printf '%s\n' "TUNEX_AGENT_ADMIN_PORT=0"
  printf '%s\n' "TUNEX_STATE_DIR=/var/lib/tunex-agent"
  [ -z "$INGRESS_RANGE" ] || printf '%s\n' "TUNEX_INGRESS_RANGE=$INGRESS_RANGE"
  [ -z "$EGRESS_RANGE" ] || printf '%s\n' "TUNEX_EGRESS_RANGE=$EGRESS_RANGE"
} > "$ENV_FILE"
chmod 0600 "$ENV_FILE"

# Reinstall replaces only this logical Agent. Never remove another TuneX
# instance on the same host.
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
if [ "$LEGACY_SELF" -eq 1 ]; then
  docker rm -f "$LEGACY_CONTAINER" >/dev/null 2>&1 || true
fi

docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --network host \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --cap-add NET_BIND_SERVICE \
  --stop-timeout 15 \
  --log-opt max-size=20m \
  --log-opt max-file=3 \
  --label "io.tunex.agent=true" \
  --label "io.tunex.agent-id=$AGENT_ID" \
  --label "io.tunex.node-id=$NODE_ID" \
  --label "io.tunex.ingress-range=$INGRESS_RANGE" \
  --label "io.tunex.egress-range=$EGRESS_RANGE" \
  -v "$ENV_FILE:/run/tunex-agent/agent.env:ro" \
  -v "$INSTANCE_STATE_DIR:/var/lib/tunex-agent" \
  "$AGENT_IMAGE" >/dev/null

echo "TuneX Agent deployed with Docker as $CONTAINER."
echo "Check status: docker ps --filter name=$CONTAINER"
echo "View logs:   docker logs -f $CONTAINER"
`;
}
