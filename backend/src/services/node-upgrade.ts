/**
 * V4-WP11B — Agent 升级闭环（渲染升级脚本 + 前置条件）。
 *
 * 升级与安装共享一个不可协商的约束：**Agent 没有 Docker 权限，Panel 也不主动连
 * 节点**。所以升级同样是"操作者在节点上执行一段由 Panel 渲染的脚本"，而不是
 * 控制面远程把节点换掉。这个模块只负责渲染那段脚本与它的前置条件。
 *
 * ── 脚本必须保证的四件事 ──
 *
 * 1. **先拉取、后停机**：镜像拉不动时节点必须还在跑旧版本。把 pull 放在 stop 之后
 *    会让一次网络抖动变成一次停机事故。
 * 2. **优雅排空**：用 SIGTERM + 容器自身的 stop-timeout（与安装脚本一致）让 Agent
 *    走 graceful drain（关闭监听 → 有界排空 → 最终上报），而不是 SIGKILL 把在途
 *    连接切断。
 * 3. **身份不变**：长期凭据在宿主机的 `/etc/tunex-agent/agent.env`，LKG 缓存在
 *    `/var/lib/tunex-agent`。两者都是宿主机路径，容器重建不会碰它们，因此
 *    node_id / agent_id / Forward 关系全部保持，无需重新 enrollment。
 * 4. **失败可回退**：脚本先记下当前镜像作为回退锚点；新版本起不来或身份校验失败
 *    时自动用旧镜像恢复，并打印手工回退命令。
 *
 * ── 升级脚本里绝不出现凭据 ──
 *
 * 身份校验用的是节点上**已有**的 agent.env，在容器内读取、只打印 HTTP 状态码：
 * 凭据既不进脚本、也不进日志、也不回到 Panel。
 */

import { redactText } from "./redaction.ts";

/**
 * Shell-safe interpolation.
 *
 * Every value that lands inside the script goes through this: it keeps only
 * characters that cannot start a new shell word or command, and it bounds the
 * length. The script is assembled from literals plus these sanitized values, so
 * there is nothing left to "redact away" — which matters because the redaction
 * layer's contract is to bound a VALUE, and passing a whole script through it
 * truncated the script itself (a 4KB script became 1KB).
 */
function safeToken(value: string, max = 200): string {
  const cleaned = String(value ?? "").replace(/[^A-Za-z0-9._:/@,=+-]/g, "");
  return cleaned.slice(0, max);
}

/** 允许的镜像引用形状（不含 shell 元字符，避免渲染进脚本后被当成命令）。 */
const IMAGE_REF_RE =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?::[0-9]{1,5})?(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*(?::[a-zA-Z0-9][a-zA-Z0-9._-]*)?(?:@sha256:[a-f0-9]{64})?$/;

export function validateAgentImageRef(value: unknown): { ok: true; image: string } | { ok: false; reason: string } {
  if (typeof value !== "string") return { ok: false, reason: "agent_image 必须是字符串" };
  const image = value.trim();
  if (image === "") return { ok: false, reason: "agent_image 不能为空" };
  if (image.length > 255) return { ok: false, reason: "agent_image 过长" };
  if (!IMAGE_REF_RE.test(image)) {
    return {
      ok: false,
      reason:
        "agent_image 不是合法的镜像引用（只允许 registry/name[:tag][@sha256:…]，不能包含空格或 shell 元字符）",
    };
  }
  return { ok: true, image };
}

/** 节点上与该次升级有关的事实（都由 Panel 持有，脚本不需要再问）。 */
export interface NodeUpgradeFacts {
  node_key: string;
  agent_id: string;
  role: string | null;
  lifecycle: string | null;
  /** 安装脚本使用固定容器名，升级脚本据此定位并重建同一个容器。 */
  container_name?: string;
}

export interface UpgradePrecondition {
  ok: boolean;
  code?: string;
  message?: string;
}

/**
 * 升级前置条件：节点应当先进入维护，才替换运行中的 Agent。
 *
 * 理由不是流程洁癖：维护语义是"不接受新业务"，此时排空可控；在 active 上直接换
 * Agent，正在被调度的 rollout 会在节点消失的窗口里失败。想带业务升级必须显式传
 * `allowActive`，返回体里会带上这个决定，便于审计。
 */
export function checkUpgradePrecondition(
  facts: NodeUpgradeFacts,
  options: { allowActive?: boolean } = {},
): UpgradePrecondition {
  if (!facts.agent_id || facts.agent_id.trim() === "") {
    return { ok: false, code: "node_has_no_agent_id", message: "该节点还没有 agent_id，请先完成安装" };
  }
  if (facts.lifecycle === "retired") {
    return { ok: false, code: "node_retired", message: "该节点已退役（单向状态），不再接受升级" };
  }
  if (facts.lifecycle !== "maintenance" && !options.allowActive) {
    return {
      ok: false,
      code: "node_not_in_maintenance",
      message:
        "升级前请先把节点置为 maintenance（避免在调度窗口内替换 Agent）；确认可以带业务升级时传 allow_active=true",
    };
  }
  return { ok: true };
}

/**
 * Value shapes that must never appear inside a rendered script. Deliberately
 * narrower than the redaction layer's rule set: these are concrete credentials,
 * not key/value pairs and not shell variable references.
 */
const SECRET_VALUE_SHAPES: readonly [string, RegExp][] = [
  ["pem_private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["bearer_token", /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/],
  ["url_credentials", /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/],
  ["long_hex", /\b[0-9a-fA-F]{32,}\b/],
  ["basic_auth", /\bBasic\s+[A-Za-z0-9+/=]{8,}/],
];

/**
 * Defence in depth for the rendered script: if a future field reintroduces a
 * credential-shaped value (a bearer token, a PEM block, a URL with credentials),
 * the render is refused rather than handed to an operator for copy-paste.
 */
function assertNoSecretShapes(script: string): string {
  // `Authorization: Bearer $TUNEX_NODE_CREDENTIAL` is a shell VARIABLE reference,
  // not a secret, so the key/value rule of the redaction layer must not be used
  // here (it would "redact" the marker and leave the reference). What matters is
  // that no *concrete* credential-shaped value was interpolated.
  //
  // A pinned digest (`@sha256:<64 hex>`) is addressable public information, so it
  // is removed before the long-hex rule runs.
  const withoutDigests = script.replace(/@sha256:[a-f0-9]{64}/g, "@sha256:<digest>");
  for (const [name, re] of SECRET_VALUE_SHAPES) {
    if (re.test(withoutDigests)) {
      throw new Error(`node-upgrade: refused to render a script containing credential-shaped content (${name})`);
    }
  }
  // Belt and braces: the shape-free path of the redaction layer must agree.
  const scrub = redactText(withoutDigests);
  if (scrub.includes("Bearer $") && !scrub.includes("Bearer $TUNEX_NODE_CREDENTIAL")) {
    throw new Error("node-upgrade: the redaction layer found something to remove in the rendered script");
  }
  return script;
}

export interface RenderedUpgrade {
  script: string;
  /** 操作者需要知道的不变量（显式说明，而不是让脚本去"暗示"）。 */
  preserves: {
    node_identity: boolean;
    credential: boolean;
    lkg_state: boolean;
    forwards: boolean;
  };
  /** 手工回退提示（脚本内部也会自动回退一次）。 */
  rollback_hint: string;
  /** 升级窗口内节点不接受新业务，便于前端提示。 */
  downtime: string;
}

export interface RenderUpgradeOptions {
  containerName?: string;
  /** 容器的 stop-timeout（秒）。默认与安装脚本一致。 */
  stopTimeoutS?: number;
  /** 身份校验用的 Panel 地址；缺省则跳过在线校验（脚本会明确说出来）。 */
  panelURL?: string | null;
}

/**
 * 渲染升级脚本。
 *
 * 脚本只做五步：记录回退锚点 → 拉取新镜像 → SIGTERM 排空 → 用同一份宿主身份重建
 * → 校验"新进程还是同一个节点"。任何一步失败都回退到旧镜像。
 */
export function renderNodeUpgradeScript(
  facts: NodeUpgradeFacts,
  targetImage: string,
  options: RenderUpgradeOptions = {},
): RenderedUpgrade {
  const container = safeToken(options.containerName?.trim() || facts.container_name?.trim() || "tunex-agent", 64) || "tunex-agent";
  const stopTimeout = options.stopTimeoutS ?? 15;
  const panel = safeToken((options.panelURL ?? "").replace(/\/+$/, ""), 255);
  const rollbackHint =
    `docker stop -t ${stopTimeout} ${container} && docker rm -f ${container}，再用旧镜像重新运行安装脚本`;

  const nodeKey = safeToken(facts.node_key, 64);
  const image = safeToken(targetImage, 255);
  const script = `#!/bin/sh
# TuneX Agent 升级脚本（V4-WP11B），由 Panel 渲染。
# 节点: ${nodeKey}  目标镜像: ${image}
#
# 它保持 node_id / agent_id / 长期凭据 / LKG 缓存 / Forward 关系不变，
# 因此不需要重新 enrollment，也不会产生新的节点身份。
set -eu

CONTAINER="${container}"
TARGET_IMAGE="${image}"
STOP_TIMEOUT="${stopTimeout}"
PANEL="${panel}"

log() { printf 'tunex-upgrade: %s\\n' "$*"; }
die() { printf 'tunex-upgrade: %s\\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "找不到 docker"
docker inspect "$CONTAINER" >/dev/null 2>&1 || die "找不到容器 $CONTAINER（请确认节点用标准安装脚本部署）"

# ── 0. 回退锚点：先记下正在跑的镜像 ────────────────────────────────────────
PREVIOUS_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER")"
[ -n "$PREVIOUS_IMAGE" ] || die "读不到当前镜像，拒绝在没有回退锚点的情况下继续"
log "当前镜像: $PREVIOUS_IMAGE"
log "目标镜像: $TARGET_IMAGE"
if [ "$PREVIOUS_IMAGE" = "$TARGET_IMAGE" ]; then
  log "已经是目标镜像，无需升级"
  exit 0
fi

# ── 1. 先拉取：拉不动就必须原样离开，节点继续跑旧版本 ──────────────────────
log "拉取目标镜像（此时节点仍在正常服务）"
if ! docker pull "$TARGET_IMAGE"; then
  die "拉取失败，已放弃升级；节点仍在运行 $PREVIOUS_IMAGE"
fi

# ── 2. 身份与状态文件必须先存在，否则重建会变成"新节点" ────────────────────
[ -f /etc/tunex-agent/agent.env ] || die "缺少 /etc/tunex-agent/agent.env（长期凭据）；请改用安装脚本重新部署"
[ -d /var/lib/tunex-agent ] || log "提示: 没有 /var/lib/tunex-agent，LKG 缓存为空（首次升级属正常）"

run_agent() {
  IMAGE="$1"
  # 与安装脚本同一组参数：同一容器名、同一宿主身份文件、同一 LKG 目录。
  docker run -d \\
    --name "$CONTAINER" \\
    --restart unless-stopped \\
    --network host \\
    --security-opt no-new-privileges:true \\
    --cap-drop ALL \\
    --cap-add NET_BIND_SERVICE \\
    --stop-timeout "$STOP_TIMEOUT" \\
    --log-opt max-size=20m \\
    --log-opt max-file=3 \\
    -v /etc/tunex-agent/agent.env:/run/tunex-agent/agent.env:ro \\
    -v /var/lib/tunex-agent:/var/lib/tunex-agent \\
    "$IMAGE" >/dev/null
}

restore_previous() {
  log "回退到 $PREVIOUS_IMAGE"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  run_agent "$PREVIOUS_IMAGE" || die "回退失败，请手工处理容器 $CONTAINER"
  log "已回退到旧版本，节点身份不变"
}

# ── 3. 优雅排空：SIGTERM + 容器 stop-timeout，让 Agent 关监听/排空/最终上报 ──
log "停止旧 Agent（SIGTERM，最多 $STOP_TIMEOUT 秒完成排空）"
docker stop -t "$STOP_TIMEOUT" "$CONTAINER" >/dev/null || log "（旧容器未能优雅停止，继续）"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

# ── 4. 用同一份宿主身份重建 ────────────────────────────────────────────────
log "用目标镜像重建容器（复用 agent.env 与 LKG 目录）"
if ! run_agent "$TARGET_IMAGE"; then
  restore_previous
  die "新版本容器未能启动"
fi

# ── 5. 校验：新进程仍然以"同一个节点"的身份通过认证 ────────────────────────
sleep 3
if ! docker inspect --format '{{.State.Running}}' "$CONTAINER" | grep -q true; then
  log "新容器没有保持运行"
  restore_previous
  die "新版本启动后退出，已回退"
fi

if [ -n "$PANEL" ]; then
  # 只打印 HTTP 状态码：凭据在容器内读取，绝不回显、绝不外传。
  CODE="$(docker exec "$CONTAINER" sh -c 'curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TUNEX_NODE_CREDENTIAL" "$0/api/internal/node/snapshot"' "$PANEL" 2>/dev/null || true)"
  case "$CODE" in
    200) log "身份校验通过（HTTP 200）：同一个 node_id/agent_id 已重新连上 Panel" ;;
    401|403) log "身份校验失败（HTTP $CODE）"; restore_previous; die "新进程认证失败，已回退" ;;
    *) log "未能完成身份校验（HTTP $\{CODE:-none}）；容器在运行，请稍后在 Panel 查看状态" ;;
  esac
else
  log "未提供 Panel 地址，跳过身份校验；请在 Panel 确认节点重新上报"
fi

log "升级完成：当前运行 $TARGET_IMAGE，节点身份与 Forward 关系未变"
log "如需手工回退：先 docker stop -t $STOP_TIMEOUT $CONTAINER，再用 $PREVIOUS_IMAGE 重新运行安装脚本"
`;

  return {
    // The script is NOT passed through the redaction layer: that layer bounds a
    // value at 1000 chars ("the artefact must not be the leak"), which truncated
    // the script. Instead every interpolated value is shell-sanitized above and
    // the test suite asserts no credential-shaped value can survive injection.
    script: assertNoSecretShapes(script),
    preserves: { node_identity: true, credential: true, lkg_state: true, forwards: true },
    rollback_hint: rollbackHint,
    downtime: `升级窗口内该节点不接受新业务；在途连接最多等待 ${stopTimeout} 秒完成排空`,
  };
}
