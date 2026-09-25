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
export function renderNodeInstallScript(): string {
  return `#!/bin/sh
set -eu

PANEL=""
TOKEN=""
AGENT_IMAGE=""
AGENT_ID=""
ROLE="BOTH"
INGRESS_RANGE=""
EGRESS_RANGE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --panel) PANEL="$2"; shift 2 ;;
    --enroll-token) TOKEN="$2"; shift 2 ;;
    --agent-image) AGENT_IMAGE="$2"; shift 2 ;;
    --agent-id) AGENT_ID="$2"; shift 2 ;;
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

case "$(uname -s)" in
  Linux) ;;
  *) echo "tunex install: only Linux is supported" >&2; exit 3 ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  echo "TuneX: Docker Engine not found; installing Docker..."
  TMP_DOCKER="$(mktemp)"
  trap 'rm -f "$TMP_DOCKER"' EXIT INT TERM
  curl -fsSL https://get.docker.com -o "$TMP_DOCKER"
  sh "$TMP_DOCKER"
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

# Pull first so a registry/network error does not consume the one-time token.
echo "TuneX: pulling Agent image $AGENT_IMAGE ..."
docker pull "$AGENT_IMAGE"

CREDENTIAL="$(curl -fsS -X POST \
  -H "Authorization: Enrollment $TOKEN" \
  -H "Accept: text/plain" \
  "$PANEL/api/internal/node/enroll")"
[ -n "$CREDENTIAL" ] || { echo "tunex install: enrollment returned an empty credential" >&2; exit 5; }

install -d -m 0700 /etc/tunex-agent
{
  printf '%s\n' "TUNEX_PANEL_HTTP_URL=$PANEL"
  printf '%s\n' "TUNEX_AGENT_ID=$AGENT_ID"
  printf '%s\n' "TUNEX_NODE_CREDENTIAL=$CREDENTIAL"
  printf '%s\n' "TUNEX_ROLE=$ROLE"
  printf '%s\n' "TUNEX_AGENT_ADMIN_PORT=0"
  [ -z "$INGRESS_RANGE" ] || printf '%s\n' "TUNEX_INGRESS_RANGE=$INGRESS_RANGE"
  [ -z "$EGRESS_RANGE" ] || printf '%s\n' "TUNEX_EGRESS_RANGE=$EGRESS_RANGE"
} > /etc/tunex-agent/agent.env
chmod 0600 /etc/tunex-agent/agent.env

docker rm -f tunex-agent >/dev/null 2>&1 || true

docker run -d \
  --name tunex-agent \
  --restart unless-stopped \
  --network host \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --cap-add NET_BIND_SERVICE \
  --log-opt max-size=20m \
  --log-opt max-file=3 \
  -v /etc/tunex-agent/agent.env:/run/tunex-agent/agent.env:ro \
  "$AGENT_IMAGE" >/dev/null

echo "TuneX Agent deployed with Docker."
echo "Check status: docker ps --filter name=tunex-agent"
echo "View logs:   docker logs -f tunex-agent"
`;
}
