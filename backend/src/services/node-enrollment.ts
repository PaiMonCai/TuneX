import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { db } from "../db.ts";
import { env } from "../env.ts";
import { generateNodeCredential, hashNodeCredential } from "./node-credential.ts";

export const NODE_ENROLLMENT_TTL_SECONDS = 10 * 60;
export const NODE_ENROLLMENT_BYTES = 32;

export interface NodeEnrollmentIssued {
  token: string;
  node_id: number;
  node_key: string;
  expires_at: string;
  install_command: string;
}

export interface EnrolledNode {
  credential: string;
  node_id: number;
  node_key: string;
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
  role: "ingress" | "egress" | "both" | null;
  port_range_min: number | null;
  port_range_max: number | null;
}, token: string): string {
  const panel = normalizedPanelUrl();
  const range = rangeValue(node.port_range_min, node.port_range_max);
  const args = [
    "--panel", shellQuote(panel),
    "--enroll-token", shellQuote(token),
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
        node: { select: { node_id: true } },
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
        ...(observedIp ? { connect_ip: observedIp } : {}),
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

    return { id: enrollment.node_id, key: enrollment.node.node_id };
  });

  if (!result) throw new NodeEnrollmentError("invalid_enrollment", 401);
  return { credential, node_id: result.id, node_key: result.key };
}

export function extractEnrollmentToken(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  const match = /^Enrollment\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() || null;
}

export const AGENT_BINARY_NAMES = new Set([
  "tunex-agent-linux-amd64",
  "tunex-agent-linux-arm64",
]);

export function agentBinaryPath(name: string): string | null {
  if (!AGENT_BINARY_NAMES.has(name)) return null;
  const root = process.env.TUNEX_AGENT_DIST_DIR?.trim() || "/app/agent-dist";
  return join(root, name);
}

/**
 * POSIX installer served by the Panel. It downloads the Agent binary from the
 * same Panel image, exchanges the short-lived enrollment token only after the
 * binary is present, writes a root-only EnvironmentFile and starts systemd.
 */
export function renderNodeInstallScript(): string {
  return `#!/bin/sh
set -eu

PANEL=""
TOKEN=""
ROLE="BOTH"
INGRESS_RANGE=""
EGRESS_RANGE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --panel) PANEL="$2"; shift 2 ;;
    --enroll-token) TOKEN="$2"; shift 2 ;;
    --role) ROLE="$2"; shift 2 ;;
    --ingress-range) INGRESS_RANGE="$2"; shift 2 ;;
    --egress-range) EGRESS_RANGE="$2"; shift 2 ;;
    *) echo "tunex install: unknown argument $1" >&2; exit 2 ;;
  esac
done

[ -n "$PANEL" ] || { echo "tunex install: --panel is required" >&2; exit 2; }
[ -n "$TOKEN" ] || { echo "tunex install: --enroll-token is required" >&2; exit 2; }

case "$(uname -s)" in
  Linux) ;;
  *) echo "tunex install: only Linux is supported" >&2; exit 3 ;;
esac

case "$(uname -m)" in
  x86_64|amd64) ARTIFACT="tunex-agent-linux-amd64" ;;
  aarch64|arm64) ARTIFACT="tunex-agent-linux-arm64" ;;
  *) echo "tunex install: unsupported architecture $(uname -m)" >&2; exit 3 ;;
esac

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT INT TERM
curl -fsSL "$PANEL/api/internal/node/binary/$ARTIFACT" -o "$TMP"
chmod 0755 "$TMP"
install -m 0755 "$TMP" /usr/local/bin/tunex-agent

CREDENTIAL="$(curl -fsS -X POST \
  -H "Authorization: Enrollment $TOKEN" \
  -H "Accept: text/plain" \
  "$PANEL/api/internal/node/enroll")"
[ -n "$CREDENTIAL" ] || { echo "tunex install: enrollment returned an empty credential" >&2; exit 4; }

install -d -m 0755 /etc/tunex-agent
{
  printf '%s\n' "TUNEX_PANEL_HTTP_URL=$PANEL"
  printf '%s\n' "TUNEX_NODE_CREDENTIAL=$CREDENTIAL"
  printf '%s\n' "TUNEX_ROLE=$ROLE"
  printf '%s\n' "TUNEX_AGENT_ADMIN_PORT=0"
  [ -z "$INGRESS_RANGE" ] || printf '%s\n' "TUNEX_INGRESS_RANGE=$INGRESS_RANGE"
  [ -z "$EGRESS_RANGE" ] || printf '%s\n' "TUNEX_EGRESS_RANGE=$EGRESS_RANGE"
} > /etc/tunex-agent/agent.env
chmod 0600 /etc/tunex-agent/agent.env

cat > /etc/systemd/system/tunex-agent.service <<'UNIT'
[Unit]
Description=TuneX Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/tunex-agent/agent.env
ExecStart=/usr/local/bin/tunex-agent
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now tunex-agent
echo "TuneX Agent installed and started."
`;
}
