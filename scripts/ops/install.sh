#!/usr/bin/env bash
# =============================================================================
# TuneX WP21 —— 一键安装器（OPS-02 的自动化入口）
#
# 语义权威：docs/v5-wp21-installer-and-docs-site-contract.md（FROZEN-1 … FROZEN-7 + §4.0 裁决）
#
# 边界（FROZEN-6，两套入口零重叠）：
#   · 只编排「首次部署」：.env 生成/校验 → docker pull → up -d → 等 db-migrate 退出码 0 → 健康验收
#   · backup / restore / rollback / alert / capacity 永远是 scripts/ops/*.sh 的职责：
#     本脚本只**调用**它们，并在调用时显式传 COMPOSE_FILE / COMPOSE_PROJECT_NAME / TUNEX_ENV_FILE
#     （绝不依赖调用者 shell 的隐式默认值 —— 否则会打到开发栈 docker-compose.yaml）
#   · 不装 Docker（缺则检测 + 给手工路径）、不建 crontab、不写自己的进度/状态文件、
#     不碰 Agent 节点生命周期（那是面板 /api/nodes/:id/enrollment 与 /upgrade-command 的职责）
#   · 永不回显/记录/落盘任何 token、口令；日志里只允许出现变量名
#
# 用法：
#   sudo scripts/ops/install.sh install   --version <git-sha>          # 首次部署
#   sudo scripts/ops/install.sh upgrade   --version <git-sha>          # 备份 → 切镜像 → 健康 → 失败回退
#   sudo scripts/ops/install.sh uninstall [--purge-data --yes]         # 停容器；默认保数据卷
#   sudo scripts/ops/install.sh status                                 # 只读：打印部署事实
#   scripts/ops/install.sh --dry-run install --version <git-sha>       # 只打印计划，零副作用、零 docker 依赖
#   scripts/ops/install.sh --check   install --version <git-sha>       # 只做前置检查（真实探测，零副作用）
#
# 选项：--allow-floating（配合 --version latest）、--standalone、--agent-image <ref>、
#       --purge-data、--yes、--reuse-env（install 专用：仅在 .env 校验通过且 TUNEX_IMAGE 与请求版本
#       一致时，允许复用"上次半途失败留下的 .env"）、--dry-run、--check、
#       --no-docker（仅与 --dry-run/--check 合用）
#
# 退出码：2 用法/参数；3 非 root；4 平台或 Docker/Compose 不满足；5 缺必需命令/文件；
#         6 同机 tunex 项目冲突；7 .env 校验不通过；8 已有部署（幂等拒绝，不再产生第二套副作用）；
#         9 运行期失败（pull / up / db-migrate / 健康验收）。
# =============================================================================
set -Eeuo pipefail

TX_E_USAGE=2
TX_E_ROOT=3
TX_E_PLATFORM=4
TX_E_TOOLS=5
TX_E_CONFLICT=6
TX_E_ENV=7
TX_E_STATE=8
TX_E_RUNTIME=9

# 被 source（测试/自检）时不执行 main —— 纯函数可单独断言。
TX_SOURCED=0
if [ "${BASH_SOURCE[0]:-}" != "${0:-}" ]; then TX_SOURCED=1; fi

TX_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TX_PROJECT_ROOT="${TUNEX_PROJECT_ROOT:-$(cd -- "$TX_SCRIPT_DIR/../.." && pwd)}"
TX_SELF="$TX_SCRIPT_DIR/install.sh"
# 生产栈：默认值**必须**是 prod compose（不是开发栈），且可以是相对路径外的绝对路径。
TX_COMPOSE_FILE="${COMPOSE_FILE:-$TX_PROJECT_ROOT/docker-compose.prod.yaml}"
TX_STANDALONE_FILE="${TUNEX_STANDALONE_FILE:-$TX_PROJECT_ROOT/docker-compose.standalone.yaml}"
TX_COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-tunex}"
TX_ENV_FILE="${TUNEX_ENV_FILE:-$TX_PROJECT_ROOT/.env}"
TX_ENV_TEMPLATE="${TUNEX_ENV_TEMPLATE:-$TX_PROJECT_ROOT/.env.production.example}"
TX_OPS_DIR="${OPS_DIR:-$TX_PROJECT_ROOT/var/ops}"
TX_BACKUP_DIR="${BACKUP_DIR:-$TX_PROJECT_ROOT/var/backups}"
TX_APP_SERVICES="${TUNEX_APP_SERVICES:-backend worker web}"
TX_MIGRATE_SERVICE="${TUNEX_MIGRATE_SERVICE:-db-migrate}"
TX_HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
TX_MIGRATE_TIMEOUT="${TX_MIGRATE_TIMEOUT:-600}"
TX_IMAGE_REPO="${TUNEX_IMAGE_REPO:-ghcr.io/paimoncai/tunex}"
TX_AGENT_IMAGE_REPO="${TUNEX_AGENT_IMAGE_REPO:-ghcr.io/paimoncai/tunex-agent}"
TX_DOCKER_DOC="https://docs.docker.com/engine/install/"
TX_MIN_COMPOSE_STANDALONE="2.24.4"

# --- 纯数据（可断言） --------------------------------------------------------
# 与 backend/src/services/node-upgrade.ts 的 IMAGE_REF_RE 同形（DoD 16 的派生副本；
# 语义权威在 TS 侧，自检里的 parity 用例会把两者的结论逐条比对）。
TX_IMAGE_REF_RE='^[A-Za-z0-9][A-Za-z0-9._-]*(:[0-9]{1,5})?(/[A-Za-z0-9][A-Za-z0-9._-]*)*(:[A-Za-z0-9][A-Za-z0-9._-]*)?(@sha256:[a-f0-9]{64})?$'
TX_ENV_REQUIRED_KEYS="AUTH_SECRET LICENSE_SECRET TUNEX_CONFIG_KEY TUNEX_LICENSE_KEY MYSQL_ROOT_PASSWORD DATABASE_URL SITE_URL TUNEX_IMAGE TUNEX_AGENT_IMAGE"
TX_ENV_GENERATED_KEYS="AUTH_SECRET LICENSE_SECRET TUNEX_CONFIG_KEY TUNEX_LICENSE_KEY MYSQL_ROOT_PASSWORD"
TX_ENV_PLACEHOLDER_RE='(change-me|changeme|replace-with)'

# --- 运行态（仅 main 会改写） ------------------------------------------------
TX_ACTION=""
TX_VERSION=""
TX_AGENT_IMAGE_OPT=""
TX_ALLOW_FLOATING=0
TX_STANDALONE=0
TX_PURGE_DATA=0
TX_REUSE_ENV=0
TX_ASSUME_YES=0
TX_DRY_RUN=0
TX_CHECK=0
TX_NO_DOCKER=0
TX_CHECK_FAIL_CODE=0
TX_FIXTURE_FILE="${TUNEX_DRYRUN_FIXTURES:-}"
TX_PANEL_IMAGE=""
TX_AGENT_IMAGE_RESOLVED=""
TX_AGENT_LATEST_VERSION_VALUE=""
TX_ENV_IMAGE_VALUE=""
TX_STANDALONE_FLAGS=""
TX_ENVFILE_FLAGS=""

# =============================================================================
# 输出
# =============================================================================
tx_log()  { printf '[installer] %s\n' "$*"; }
tx_warn() { printf '[installer] WARN: %s\n' "$*" >&2; }
tx_err()  { printf '[installer] ERROR: %s\n' "$*" >&2; }
tx_fail() { local code="$1"; shift; tx_err "$*"; exit "$code"; }

tx_usage() {
  awk 'NR==1{next} /^set -Eeuo pipefail/{exit} {sub(/^# ?/,""); print}' "${BASH_SOURCE[0]}"
  exit "${1:-0}"
}

tx_quote_cmd() {
  local out="" a
  for a in "$@"; do
    if [ -n "${BACKUP_PASSPHRASE:-}" ] && [ "$a" = "${BACKUP_PASSPHRASE}" ]; then a="<redacted>"; fi
    out="$out $(printf '%q' "$a")"
  done
  printf '%s' "${out# }"
}

# =============================================================================
# dry-run / 测试夹具（TUNEX_DRYRUN_FIXTURES 指向 key=value 文件） —— 只影响 dry-run
# =============================================================================
tx_fixture() { # <key> <default>
  local k="$1" d="${2:-}" v=""
  if [ "$TX_DRY_RUN" -eq 1 ] && [ -n "$TX_FIXTURE_FILE" ] && [ -f "$TX_FIXTURE_FILE" ]; then
    v="$(sed -n "s/^${k}=//p" "$TX_FIXTURE_FILE" | tail -1)"
  fi
  if [ -z "$v" ]; then v="$d"; fi
  printf '%s' "$v"
}

tx_run() { # 唯一的"执行"入口：dry-run 下只打印，绝不执行
  if [ "$TX_DRY_RUN" -eq 1 ]; then
    printf '[dry-run] %s\n' "$(tx_quote_cmd "$@")"
    return 0
  fi
  "$@"
}

# =============================================================================
# 纯函数（测试直接断言）
# =============================================================================
tx_image_ref_trim() { printf '%s' "${1:-}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'; }

tx_image_ref_valid() { # <ref> → 0 合法 / 1 非法（与 node-upgrade.ts validateAgentImageRef 同结论）
  local ref
  ref="$(tx_image_ref_trim "${1:-}")"
  [ -n "$ref" ] || return 1
  [ "${#ref}" -le 255 ] || return 1
  printf '%s' "$ref" | grep -Eq "$TX_IMAGE_REF_RE" || return 1
  return 0
}

tx_git_sha_valid() { printf '%s' "${1:-}" | grep -Eq '^[0-9a-f]{40}$'; }

# 幂等三态：容器数 > 0 → same/different；无容器但 .env 在 → partial；都没有 → none
tx_classify_deploy_state() { # <has_env 0|1> <env_image> <container_count> <requested_image>
  local has_env="$1" env_image="${2:-}" count="${3:-0}" want="${4:-}"
  if [ "${count:-0}" -gt 0 ]; then
    if [ "$has_env" -eq 1 ] && [ "$env_image" = "$want" ]; then printf 'same'; else printf 'different'; fi
    return 0
  fi
  if [ "$has_env" -eq 1 ]; then printf 'partial'; else printf 'none'; fi
}

tx_env_get() { sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -1; }

tx_env_missing_keys() { # <file> → 每行一个缺失键名（缺 = 无键或空值）
  local f="$1" k
  for k in $TX_ENV_REQUIRED_KEYS; do
    if [ -z "$(tx_env_get "$f" "$k")" ]; then printf '%s\n' "$k"; fi
  done
}

tx_env_placeholder_keys() { # <file> → 每行一个仍是模板占位值的键名
  local f="$1" k v
  for k in $TX_ENV_REQUIRED_KEYS; do
    v="$(tx_env_get "$f" "$k")"
    if [ -n "$v" ] && printf '%s' "$v" | grep -Eqi "$TX_ENV_PLACEHOLDER_RE"; then printf '%s\n' "$k"; fi
  done
}

tx_env_perm_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null || printf 'unknown'; }

tx_env_validate() { # <file> → findings(missing:K / placeholder:K / perms:M / absent)；0=通过
  local f="$1" k rc=0 mode
  if [ ! -f "$f" ]; then printf 'absent\n'; return 1; fi
  for k in $(tx_env_missing_keys "$f"); do printf 'missing:%s\n' "$k"; rc=1; done
  for k in $(tx_env_placeholder_keys "$f"); do printf 'placeholder:%s\n' "$k"; rc=1; done
  mode="$(tx_env_perm_mode "$f")"
  if [ "$mode" != "600" ]; then printf 'perms:%s\n' "$mode"; rc=1; fi
  return "$rc"
}

tx_env_report_findings() { # <file> <finding...>
  local f="$1"; shift
  tx_err ".env 校验未通过：$f"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      absent)      tx_err "  · 文件不存在" ;;
      missing:*)   tx_err "  · 缺少必需键：${1#missing:}（只报键名，不回显任何值）" ;;
      placeholder:*) tx_err "  · 仍是模板占位值：${1#placeholder:}（每套部署必须独立生成）" ;;
      perms:*)     tx_err "  · 权限是 ${1#perms:}（必须 600）—— 修： chmod 600 $f" ;;
      *)           tx_err "  · $1" ;;
    esac
    shift
  done
}

# 缺 Docker 的检测与指引（OPEN-2 裁决：**不**自动安装）。
# 唯一真相：不出现 get.docker.com / 任何 curl|sh；只给官方文档 + 发行版包管理器 + 离线路径。
tx_docker_guidance() { # <os-release 路径>
  local osrel="${1:-/etc/os-release}" distro="" hint=""
  distro="$(sed -n 's/^ID=//p' "$osrel" 2>/dev/null | tr -d '"' | head -1)"
  case "${distro:-}" in
    debian|ubuntu) hint="Debian/Ubuntu：用 apt 包管理器从官方仓库装（docker-ce / docker-compose-plugin；apt 校验仓库签名）—— ${TX_DOCKER_DOC}ubuntu/" ;;
    rhel|centos|rocky|almalinux|fedora) hint="RHEL 系：用 dnf/yum 包管理器从官方仓库装（docker-ce / docker-compose-plugin；dnf 校验 RPM 签名）—— ${TX_DOCKER_DOC}centos/" ;;
    opensuse*|sles) hint="SUSE 系：用 zypper 包管理器装（docker + docker-compose 插件）—— ${TX_DOCKER_DOC}sles/" ;;
    alpine) hint="Alpine：用 apk 包管理器（apk add docker docker-cli-compose；校验包签名）—— ${TX_DOCKER_DOC}" ;;
    arch) hint="Arch：用 pacman 包管理器（pacman -S docker docker-compose；校验包签名）—— ${TX_DOCKER_DOC}" ;;
    *) hint="用发行版包管理器装（apt / dnf / yum / zypper / apk / pacman 均可，包管理器会校验签名）—— 按发行版官方文档" ;;
  esac
  cat <<EOF
TuneX 不会替你安装 Docker（WP21 OPEN-2 裁决：fail-closed —— 未校验的 root 代码执行不进产品路径）。
请任选一条手工路径，装好后重跑本命令：
  1) 官方安装文档（按发行版选）：$TX_DOCKER_DOC
  2) $hint
  3) 离线/受限环境：用发行版自带包或 Docker 官方静态包，按官方文档校验 GPG/checksum 后再安装。
自检：docker --version && docker compose version   （需要 Compose v2 插件，不是旧的 docker-compose）
EOF
}

tx_backup_passphrase_hint() {
  cat <<'EOF'
非交互环境取不到备份口令：升级必须先成功备份，因此这里直接拒绝（不留无保护窗口）。
请把口令作为环境变量传进来（只经 env 传递，不进 argv/日志/文件），例如：
  sudo -E env BACKUP_PASSPHRASE=… scripts/ops/install.sh upgrade --version <sha>
EOF
}

# =============================================================================
# 查询（dry-run 下由夹具回答，真实模式下才碰 docker）
# =============================================================================
tx_uid() { if [ "$TX_DRY_RUN" -eq 1 ]; then tx_fixture uid 0; else id -u; fi; }
tx_uname_s() { if [ "$TX_DRY_RUN" -eq 1 ]; then tx_fixture uname_s Linux; else uname -s; fi; }
tx_docker_present() {
  if [ "$TX_DRY_RUN" -eq 1 ] || [ "$TX_NO_DOCKER" -eq 1 ]; then
    [ "$(tx_fixture docker_present 1)" = "1" ]
    return $?
  fi
  command -v docker >/dev/null 2>&1
}
tx_compose_available() {
  if [ "$TX_DRY_RUN" -eq 1 ] || [ "$TX_NO_DOCKER" -eq 1 ]; then
    [ "$(tx_fixture compose_ok 1)" = "1" ]
    return $?
  fi
  docker compose version >/dev/null 2>&1
}
tx_compose_version() {
  if [ "$TX_DRY_RUN" -eq 1 ] || [ "$TX_NO_DOCKER" -eq 1 ]; then tx_fixture compose_version "2.30.0"; return 0; fi
  docker compose version 2>/dev/null | sed -n 's/.*version v\{0,1\}\([0-9][0-9.]*\).*/\1/p' | head -1
}
tx_command_exists() {
  local c="$1"
  if [ "$TX_DRY_RUN" -eq 1 ]; then
    case " $(tx_fixture missing_commands '') " in *" $c "*) return 1 ;; esac
    return 0
  fi
  command -v "$c" >/dev/null 2>&1
}
tx_project_container_count() {
  if [ "$TX_DRY_RUN" -eq 1 ]; then tx_fixture project_container_count 0; return 0; fi
  docker ps -a --filter "label=com.docker.compose.project=$TX_COMPOSE_PROJECT" \
    --format '{{.Names}}' 2>/dev/null | grep -c . || true
}
tx_project_working_dirs() {
  if [ "$TX_DRY_RUN" -eq 1 ]; then tx_fixture project_working_dirs ""; return 0; fi
  docker ps -a --filter "label=com.docker.compose.project=$TX_COMPOSE_PROJECT" \
    --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null || true
}
tx_service_running() {
  local svc="$1" cid status
  cid="$(tx_compose_capture ps -q "$svc" 2>/dev/null | head -1)" || return 1
  [ -n "$cid" ] || return 1
  status="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || printf 'unknown')"
  [ "$status" = "running" ]
}
tx_image_digest() {
  local d
  if [ "$TX_DRY_RUN" -eq 1 ]; then tx_fixture image_digest "sha256:dryrun0000000000000000000000000000000000000000000000000000000000"; return 0; fi
  d="$(docker image inspect "$1" --format '{{index .RepoDigests 0}}' 2>/dev/null)" || true
  # 本地构建/不存在的镜像会给出空串或 "<no value>"；统一成 rollback.sh 的 local:<image> 口径，
  # 并去掉换行/空白，避免把裸换行打进 status 的一行里。
  case "$d" in
    ''|'<no value>'|*[![:print:]]*) d="" ;;
  esac
  if [ -z "$d" ]; then d="local:$1"; fi
  printf '%s' "$d"
}

# HTTP 码只取一份（curl 自己会打 "000"；再 `|| echo 000` 会变成 "000000"，status 里就出现怪值）。
tx_http_code() { # <url>
  local c
  if [ "$TX_DRY_RUN" -eq 1 ]; then tx_fixture health_http 200; return 0; fi
  c="$(curl -sS -o /dev/null -w '%{http_code}' -m 3 "$1" 2>/dev/null)" || true
  case "$c" in ''|*[!0-9]*) c=000 ;; esac
  printf '%s' "$c"
}
tx_backup_manifest_count() {
  if [ "$TX_DRY_RUN" -eq 1 ]; then tx_fixture backup_manifest_count 0; return 0; fi
  find "$TX_BACKUP_DIR" -name '*.manifest.json' 2>/dev/null | grep -c . || true
}
tx_health_url() { printf 'http://127.0.0.1:%s/healthz' "${TUNEX_API_PORT:-13001}"; }
tx_ready_url()  { printf 'http://127.0.0.1:%s/readyz'  "${TUNEX_API_PORT:-13001}"; }

# =============================================================================
# compose 调用（显式项目名/文件/env；dry-run 只打印）
# =============================================================================
tx_prepare_compose_args() {
  TX_STANDALONE_FLAGS=""
  if [ "$TX_STANDALONE" -eq 1 ]; then TX_STANDALONE_FLAGS="-f $TX_STANDALONE_FILE"; fi
  TX_ENVFILE_FLAGS=""
  if [ -f "$TX_ENV_FILE" ]; then TX_ENVFILE_FLAGS="--env-file $TX_ENV_FILE"; fi
}
# shellcheck disable=SC2086  # 有意的分词：路径已在 preflight 拒绝空白字符
tx_compose() { tx_run docker compose -p "$TX_COMPOSE_PROJECT" $TX_STANDALONE_FLAGS -f "$TX_COMPOSE_FILE" $TX_ENVFILE_FLAGS "$@"; }
# shellcheck disable=SC2086
tx_compose_capture() { docker compose -p "$TX_COMPOSE_PROJECT" $TX_STANDALONE_FLAGS -f "$TX_COMPOSE_FILE" $TX_ENVFILE_FLAGS "$@"; }

tx_pull() { # <image>
  if [ "$TX_DRY_RUN" -eq 1 ]; then
    printf '[dry-run] %s\n' "$(tx_quote_cmd docker pull "$1")"
    if [ "$(tx_fixture pull_result ok)" != "ok" ]; then tx_err "[dry-run] docker pull 失败（夹具 pull_result）"; return 1; fi
    return 0
  fi
  docker pull "$1"
}

# =============================================================================
# 前置检查（tx_gate：--check 累积报告，其余模式立即失败）
# =============================================================================
tx_gate() { # <名称> <ok 0|1> <退出码> <提示>
  if [ "$2" -eq 0 ]; then tx_log "[ok]   $1"; return 0; fi
  tx_err "[FAIL] $1${4:+ —— $4}"
  if [ "$TX_CHECK" -eq 1 ]; then
    if [ "$TX_CHECK_FAIL_CODE" -eq 0 ]; then TX_CHECK_FAIL_CODE="$3"; fi
    return 0
  fi
  exit "$3"
}

tx_preflight() { # <install|upgrade|uninstall|status>
  local mode="$1" tools="" c missing="" v
  if [ "$mode" != "status" ]; then
    tx_gate "以 root 运行（id -u = 0）" "$([ "$(tx_uid)" = "0" ] && printf 0 || printf 1)" "$TX_E_ROOT" \
      "请用 sudo $TX_SELF $TX_ACTION …"
  fi
  tx_gate "平台是 Linux" "$([ "$(tx_uname_s)" = "Linux" ] && printf 0 || printf 1)" "$TX_E_PLATFORM" \
    "只支持 Linux（Windows/macOS 请用容器/虚拟机）"
  tx_gate "部署目录不含空白字符（路径要进 compose -f）" \
    "$(case "$TX_PROJECT_ROOT" in *[[:space:]]*) printf 1 ;; *) printf 0 ;; esac)" "$TX_E_TOOLS" \
    "把仓库放到不含空格的路径（例如 /opt/TuneX）"
  tx_gate "compose 文件存在（生产栈，不是开发栈）" "$([ -f "$TX_COMPOSE_FILE" ] && printf 0 || printf 1)" "$TX_E_TOOLS" \
    "缺 $TX_COMPOSE_FILE"
  if [ "$TX_STANDALONE" -eq 1 ]; then
    tx_gate "standalone overlay 存在" "$([ -f "$TX_STANDALONE_FILE" ] && printf 0 || printf 1)" "$TX_E_TOOLS" \
      "缺 $TX_STANDALONE_FILE（--standalone 需要它）"
    v="$(tx_compose_version)"
    tx_gate "standalone overlay 需要 Compose >= $TX_MIN_COMPOSE_STANDALONE（当前 ${v:-未知}）" \
      "$(tx_version_ge "${v:-0}" "$TX_MIN_COMPOSE_STANDALONE" && printf 0 || printf 1)" "$TX_E_PLATFORM" \
      "升级 Compose 插件，或改用宿主机反代模式（不加 --standalone）"
  fi
  case "$mode" in
    install|upgrade) tools="curl openssl sha256sum jq" ;;
    status)          tools="curl jq" ;;
    *)               tools="" ;;
  esac
  for c in $tools; do tx_command_exists "$c" || missing="$missing $c"; done
  tx_gate "必需命令齐全（$tools）" "$([ -z "$missing" ] && printf 0 || printf 1)" "$TX_E_TOOLS" \
    "缺：$missing（按发行版包管理器安装；rollback.sh 依赖 jq）"
  if [ "$mode" != "status" ]; then
    tx_gate "Docker 已安装（本脚本不代装）" "$(tx_docker_present && printf 0 || printf 1)" "$TX_E_PLATFORM" \
      "$(tx_docker_guidance /etc/os-release)"
    tx_gate "Docker Compose v2 可用" "$(tx_compose_available && printf 0 || printf 1)" "$TX_E_PLATFORM" \
      "$(tx_docker_guidance /etc/os-release)"
  fi
  if [ "$mode" != "status" ]; then
    tx_check_project_conflict
  fi
  case "$mode" in
    install)
      if [ -f "$TX_ENV_FILE" ]; then tx_check_env_or_fail; fi ;;
    upgrade)
      if [ ! -f "$TX_ENV_FILE" ]; then
        tx_gate "存在可升级的部署（$TX_ENV_FILE）" 1 "$TX_E_STATE" \
          "没有可升级的部署：首次部署请用 sudo $TX_SELF install --version <sha>"
      fi
      tx_check_env_or_fail
      tx_check_backup_passphrase_or_fail ;;
    uninstall)
      if [ -f "$TX_ENV_FILE" ]; then
        local findings
        findings="$(tx_env_validate "$TX_ENV_FILE" || true)"
        [ -z "$findings" ] || tx_warn ".env 校验有问题（uninstall 不需要读值，先继续）：$(printf '%s' "$findings" | tr '\n' ' ')"
      fi ;;
    status) ;;
  esac
  tx_after_preflight
}

# --check：前置检查做完就停 —— 绝不带着"检查通过"的状态继续执行动作（否则 --check 会变成真部署）。
tx_after_preflight() {
  if [ "$TX_CHECK" -ne 1 ]; then return 0; fi
  if [ "$TX_CHECK_FAIL_CODE" -ne 0 ]; then
    tx_err "check 未通过（退出码 $TX_CHECK_FAIL_CODE）—— 未做任何变更"
    exit "$TX_CHECK_FAIL_CODE"
  fi
  tx_log "check 全部通过（未做任何变更）"
  exit 0
}

tx_version_ge() { # <a> <b> → 0 表示 a >= b（简化语义版本比较）
  local a="$1" b="$2"
  [ "$a" = "$b" ] && return 0
  local lowest
  lowest="$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -1)"
  [ "$lowest" = "$b" ]
}

tx_check_env_or_fail() {
  local findings
  findings="$(tx_env_validate "$TX_ENV_FILE" || true)"
  if [ -n "$findings" ]; then
    if [ "$TX_CHECK" -eq 1 ]; then
      tx_err "[FAIL] .env 校验（$TX_ENV_FILE）"
      tx_env_report_findings "$TX_ENV_FILE" $findings
      if [ "$TX_CHECK_FAIL_CODE" -eq 0 ]; then TX_CHECK_FAIL_CODE="$TX_E_ENV"; fi
      return 0
    fi
    tx_env_report_findings "$TX_ENV_FILE" $findings
    exit "$TX_E_ENV"
  fi
  tx_log "[ok]   .env 校验（必需键齐全、非占位值、权限 600）"
}

# 备份口令是否可非交互获得（DoD 10）。纯函数：0=可以，1=拒绝并打印原因。
tx_check_backup_passphrase() { # <stdin_is_tty 0|1>
  if [ -n "${BACKUP_PASSPHRASE:-}" ]; then return 0; fi
  if [ "$1" -eq 1 ]; then return 0; fi
  tx_backup_passphrase_hint >&2
  return 1
}
tx_check_backup_passphrase_or_fail() {
  local tty=0
  if [ "$TX_DRY_RUN" -eq 1 ]; then
    [ "$(tx_fixture passphrase_available 1)" = "1" ] && return 0
  fi
  if [ -t 0 ]; then tty=1; fi
  tx_gate "备份口令可非交互获得（BACKUP_PASSPHRASE 或交互 TTY）" \
    "$(tx_check_backup_passphrase "$tty" && printf 0 || printf 1)" "$TX_E_TOOLS" ""
}

tx_check_project_conflict() {
  local count dirs
  count="$(tx_project_container_count)"
  if [ "${count:-0}" -le 0 ]; then
    tx_log "[ok]   无同机 tunex 项目冲突"
    return 0
  fi
  dirs="$(tx_project_working_dirs)"
  local offenders=""
  if [ -z "$dirs" ]; then
    offenders="<容器缺少 com.docker.compose.project.working_dir 标签>"
  else
    local oldifs="$IFS" d
    IFS='
'
    set -f
    for d in $dirs; do
      if [ "$d" != "$TX_PROJECT_ROOT" ]; then offenders="$offenders $d"; fi
    done
    IFS="$oldifs"
    set +f
  fi
  if [ -n "$offenders" ]; then
    tx_gate "同机已有项目名 '$TX_COMPOSE_PROJECT' 的容器（不属于本部署目录）" 1 "$TX_E_CONFLICT" \
      "冲突来源：$offenders —— 生产/开发栈的项目名都是 $TX_COMPOSE_PROJECT，不能同时 up（docs/production-deploy.md §1）"
  fi
  tx_log "[ok]   项目名 '$TX_COMPOSE_PROJECT' 的容器都属于本部署目录"
}

# =============================================================================
# .env 生成 / 载入
# =============================================================================
tx_gen_secret() { openssl rand -base64 32 | tr '+/' '-_'; }

tx_env_set() { # <file> <key> <value> —— 值经 ENVIRON 传入，避免 awk 解释转义
  local f="$1" tmp
  tmp="$(mktemp)"
  TX_K="$2" TX_V="$3" awk '
    BEGIN { k=ENVIRON["TX_K"]; v=ENVIRON["TX_V"]; done=0 }
    index($0, k"=") == 1 { print k"="v; done=1; next }
    { print }
    END { if (done == 0) print k"="v }
  ' "$f" > "$tmp"
  cat "$tmp" > "$f"
  rm -f "$tmp"
}

tx_env_generate() {
  local root_pw="" k v
  [ -f "$TX_ENV_TEMPLATE" ] || tx_fail "$TX_E_ENV" "模板不存在：$TX_ENV_TEMPLATE"
  if [ "$TX_DRY_RUN" -eq 1 ]; then
    printf '[dry-run] %s\n' "$(tx_quote_cmd cp "$TX_ENV_TEMPLATE" "$TX_ENV_FILE")"
    printf '[dry-run] 随机生成（值不回显）：%s；写入 TUNEX_IMAGE=%s / TUNEX_AGENT_IMAGE=%s；chmod 600 %s\n' \
      "$TX_ENV_GENERATED_KEYS" "$TX_PANEL_IMAGE" "${TX_AGENT_IMAGE_RESOLVED:-<保持原值>}" "$TX_ENV_FILE"
    return 0
  fi
  ( umask 077; cp "$TX_ENV_TEMPLATE" "$TX_ENV_FILE" )
  for k in $TX_ENV_GENERATED_KEYS; do
    v="$(tx_gen_secret)"
    tx_env_set "$TX_ENV_FILE" "$k" "$v"
    if [ "$k" = "MYSQL_ROOT_PASSWORD" ]; then root_pw="$v"; fi
  done
  tx_env_set "$TX_ENV_FILE" "DATABASE_URL" "mysql://root:$root_pw@mysql:3306/${TUNEX_DB_NAME:-tunex}"
  tx_env_set "$TX_ENV_FILE" "TUNEX_IMAGE" "$TX_PANEL_IMAGE"
  if [ -n "$TX_AGENT_IMAGE_RESOLVED" ]; then tx_env_set "$TX_ENV_FILE" "TUNEX_AGENT_IMAGE" "$TX_AGENT_IMAGE_RESOLVED"; fi
  if [ -n "$TX_AGENT_LATEST_VERSION_VALUE" ]; then
    tx_env_set "$TX_ENV_FILE" "TUNEX_AGENT_LATEST_VERSION" "$TX_AGENT_LATEST_VERSION_VALUE"
  fi
  chmod 600 "$TX_ENV_FILE"
  unset root_pw v
  tx_log "已生成 $TX_ENV_FILE（chmod 600；密钥只写入文件，不回显、不进日志、不进 argv）"
  tx_log "  · 已随机生成（值不回显）：$TX_ENV_GENERATED_KEYS"
  tx_log "  · 首启管理员凭据落点（由 compose 的 db-migrate 写出）：$TX_PROJECT_ROOT/.admin-credentials"
  tx_log "  · 若模板里仍有 SITE_URL / SMTP_* / ACME_EMAIL 等示例值，请按部署实际填写（本脚本不改业务配置）"
}

tx_load_env() {
  [ -f "$TX_ENV_FILE" ] || return 0
  set -a
  # shellcheck disable=SC1090
  . "$TX_ENV_FILE"
  set +a
}

# =============================================================================
# 部署历史（只追加一条、字段与 rollback.sh 的 current_state 同形；不引入自己的状态文件）
# =============================================================================
tx_history_append() { # <image> <digest> <action>
  local f="$TX_OPS_DIR/deploy-history.jsonl" commit line
  commit="$(git -C "$TX_PROJECT_ROOT" rev-parse HEAD 2>/dev/null || printf 'unknown')"
  line="$(jq -nc --arg c "$commit" --arg i "$1" --arg d "$2" --arg t "$(date -Iseconds)" --arg a "$3" \
    '{commit:$c, image:$i, digest:$d, at:$t, action:$a}')"
  if [ "$TX_DRY_RUN" -eq 1 ]; then
    printf '[dry-run] 追加部署历史 %s: %s\n' "$f" "$line"
    return 0
  fi
  mkdir -p "$TX_OPS_DIR"
  printf '%s\n' "$line" >> "$f"
  tx_log "部署历史已追加（$f）：$line"
}

# =============================================================================
# 等待 db-migrate / 健康验收
# =============================================================================
tx_wait_migrate() {
  local deadline cid state exit_code
  if [ "$TX_DRY_RUN" -eq 1 ]; then
    printf '[dry-run] 等待 %s 退出（超时 %ss）\n' "$TX_MIGRATE_SERVICE" "$TX_MIGRATE_TIMEOUT"
    if [ "$(tx_fixture migrate_exit 0)" != "0" ]; then
      tx_err "[dry-run] $TX_MIGRATE_SERVICE 退出码非 0（夹具 migrate_exit）"
      return 1
    fi
    printf '[dry-run] %s 退出码 0\n' "$TX_MIGRATE_SERVICE"
    return 0
  fi
  deadline=$(( $(date +%s) + TX_MIGRATE_TIMEOUT ))
  while :; do
    cid="$(tx_compose_capture ps -a -q "$TX_MIGRATE_SERVICE" 2>/dev/null | head -1)" || cid=""
    if [ -n "$cid" ]; then
      state="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || printf 'unknown')"
      if [ "$state" = "exited" ] || [ "$state" = "dead" ]; then
        exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$cid" 2>/dev/null || printf '1')"
        if [ "$exit_code" = "0" ]; then return 0; fi
        tx_err "$TX_MIGRATE_SERVICE 退出码 $exit_code（迁移失败）—— 排查：docker logs tunex-db-migrate；数据层恢复必须人工：scripts/ops/restore.sh <backup-id> --yes"
        return 1
      fi
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      tx_err "等待 $TX_MIGRATE_SERVICE 超时（${TX_MIGRATE_TIMEOUT}s）—— docker logs tunex-db-migrate"
      return 1
    fi
    sleep 3
  done
}

tx_wait_healthy() {
  local deadline code ready running
  if [ "$TX_DRY_RUN" -eq 1 ]; then
    code="$(tx_fixture health_http 200)"; ready="$(tx_fixture ready_http 200)"; running="$(tx_fixture app_running 1)"
    printf '[dry-run] 健康验收：/healthz=%s /readyz=%s %s running=%s\n' "$code" "$ready" "$TX_APP_SERVICES" "$running"
    if [ "$code" = "200" ] && [ "$ready" = "200" ] && [ "$running" = "1" ]; then return 0; fi
    return 1
  fi
  deadline=$(( $(date +%s) + TX_HEALTH_TIMEOUT ))
  while :; do
    code="$(tx_http_code "$(tx_health_url)")"
    ready="$(tx_http_code "$(tx_ready_url)")"
    running=1
    for s in $TX_APP_SERVICES; do tx_service_running "$s" || running=0; done
    if [ "$code" = "200" ] && [ "$ready" = "200" ] && [ "$running" -eq 1 ]; then return 0; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then break; fi
    sleep 3
  done
  tx_err "健康验收失败（healthz=$code readyz=$ready running=$running）—— docker compose -p $TX_COMPOSE_PROJECT -f $TX_COMPOSE_FILE ps；docker logs tunex-backend"
  return 1
}

# =============================================================================
# 版本 → 镜像引用
# =============================================================================
tx_resolve_images() {
  local v="$TX_VERSION"
  TX_PANEL_IMAGE=""; TX_AGENT_IMAGE_RESOLVED=""; TX_AGENT_LATEST_VERSION_VALUE=""
  case "$v" in
    "") tx_fail "$TX_E_USAGE" "$TX_ACTION 需要 --version <git-sha>（版本锚是 sha；latest 必须显式 --allow-floating）" ;;
    latest)
      [ "$TX_ALLOW_FLOATING" -eq 1 ] || tx_fail "$TX_E_USAGE" \
        "--version latest 是浮动 tag：必须显式加 --allow-floating（FROZEN-2）；实际 digest 会记入 $TX_OPS_DIR/deploy-history.jsonl"
      TX_PANEL_IMAGE="$TX_IMAGE_REPO:latest"; TX_AGENT_IMAGE_RESOLVED="$TX_AGENT_IMAGE_REPO:latest" ;;
    *)
      case "$v" in
        */*|*:*)
          tx_image_ref_valid "$v" || tx_fail "$TX_E_USAGE" \
            "--version 既不是 40 位 git sha 也不是合法镜像引用：$v（只允许 registry/name[:tag][@sha256:…]）"
          TX_PANEL_IMAGE="$(tx_image_ref_trim "$v")"
          case "$TX_PANEL_IMAGE" in
            "$TX_IMAGE_REPO":*) TX_AGENT_IMAGE_RESOLVED="$TX_AGENT_IMAGE_REPO:${TX_PANEL_IMAGE##*:}" ;;
            *) tx_warn "无法从 $TX_PANEL_IMAGE 推导 Agent 镜像 tag（节点侧才拉 Agent 镜像；可用 --agent-image 显式指定）" ;;
          esac ;;
        *)
          tx_git_sha_valid "$v" || tx_fail "$TX_E_USAGE" \
            "--version 需要 40 位 git sha 或合法镜像引用：$v"
          TX_PANEL_IMAGE="$TX_IMAGE_REPO:$v"; TX_AGENT_IMAGE_RESOLVED="$TX_AGENT_IMAGE_REPO:$v"; TX_AGENT_LATEST_VERSION_VALUE="$v" ;;
      esac ;;
  esac
  if [ -n "$TX_AGENT_IMAGE_OPT" ]; then
    tx_image_ref_valid "$TX_AGENT_IMAGE_OPT" || tx_fail "$TX_E_USAGE" "--agent-image 不是合法镜像引用：$TX_AGENT_IMAGE_OPT"
    TX_AGENT_IMAGE_RESOLVED="$(tx_image_ref_trim "$TX_AGENT_IMAGE_OPT")"
  fi
}

# .env 里当前声明的面板镜像（没有 .env 时为空）。
tx_env_current_image() {
  if [ -f "$TX_ENV_FILE" ]; then tx_env_get "$TX_ENV_FILE" TUNEX_IMAGE; fi
}

# 幂等三态。**调用方必须先自己执行** `TX_ENV_IMAGE_VALUE="$(tx_env_current_image)"`：
# tx_deploy_state 是用 `state="$(tx_deploy_state)"` 调用的，命令替换跑在子 shell 里，
# 函数内部对 TX_ENV_IMAGE_VALUE 的赋值传不回父 shell（早期版本就踩了这个坑：拒绝信息里
# "当前版本"恒为空）。
tx_deploy_state() {
  local count
  count="$(tx_project_container_count)"
  tx_classify_deploy_state "$([ -f "$TX_ENV_FILE" ] && printf 1 || printf 0)" \
    "${TX_ENV_IMAGE_VALUE:-}" "${count:-0}" "$TX_PANEL_IMAGE"
}

tx_refuse_install_state() { # <state>
  case "$1" in
    same) tx_fail "$TX_E_STATE" "install 拒绝：已存在同一版本部署（TUNEX_IMAGE=$TX_ENV_IMAGE_VALUE）。
  查看现状： sudo $TX_SELF status
  刷新部署（保留数据）： sudo $TX_SELF upgrade --version $TX_VERSION" ;;
    different) tx_fail "$TX_E_STATE" "install 拒绝：已有部署但版本不同（当前 ${TX_ENV_IMAGE_VALUE:-无 .env}，请求 $TX_PANEL_IMAGE）。
  保留数据升级： sudo $TX_SELF upgrade --version $TX_VERSION
  彻底重来：     sudo $TX_SELF uninstall --purge-data --yes  然后重跑 install" ;;
    partial) tx_fail "$TX_E_STATE" "install 拒绝：检测到 .env 但没有运行中的容器（上次安装可能中断）。
  安装器不自动复用、也不自动清理（fail-closed）。请先 sudo $TX_SELF status 判断；
  确认要从头再来：人工把 .env 移走（例如 mv $TX_ENV_FILE ${TX_ENV_FILE}.broken-\$(date +%s)）后重跑 install。" ;;
  esac
}

# =============================================================================
# 动作
# =============================================================================
tx_action_install() {
  tx_log "动作=install（首次部署）
  部署目录   : $TX_PROJECT_ROOT
  compose    : $TX_COMPOSE_FILE
  项目名     : $TX_COMPOSE_PROJECT
  .env       : $TX_ENV_FILE"
  tx_resolve_images
  tx_preflight install
  tx_prepare_compose_args
  local state reuse_env=0
  TX_ENV_IMAGE_VALUE="$(tx_env_current_image)"
  state="$(tx_deploy_state)"
  if [ "$state" = "partial" ]; then
    # partial = 有 .env、无容器（上次安装半途失败）。默认拒绝；
    # `--reuse-env` 是**显式**复位开关，且只在"校验通过 + 版本一致"两条件同时满足时放行。
    if [ "$TX_REUSE_ENV" -ne 1 ]; then
      tx_refuse_install_state "$state"
    fi
    if [ "$TX_ENV_IMAGE_VALUE" != "$TX_PANEL_IMAGE" ]; then
      tx_fail "$TX_E_STATE" "install --reuse-env 拒绝：.env 里的 TUNEX_IMAGE=${TX_ENV_IMAGE_VALUE:-空} 与本次请求 $TX_PANEL_IMAGE 不一致。
  保留数据升级请用： sudo $TX_SELF upgrade --version <sha>
  要从头再来请人工处理 .env（安装器不覆盖既有配置）"
    fi
    tx_log "--reuse-env：.env 校验通过且 TUNEX_IMAGE 与请求版本一致（$TX_PANEL_IMAGE）→ 复用既有 .env（值不改、权限不动）"
    reuse_env=1
  elif [ "$state" != "none" ]; then
    tx_refuse_install_state "$state"
  fi
  if [ "$reuse_env" -eq 1 ]; then
    tx_log "复用既有 .env：$TX_ENV_FILE（不覆盖、不重写任何键）"
  else
    tx_log "探测：本机没有 tunex 生产栈（无 .env、无项目容器）→ 继续"
    # 走到这里状态一定是 none：`.env` 存在的那三种情况（same/different/partial）都在上面被拒绝了，
    # 所以安装器在结构上不可能覆盖用户既有配置 —— 这是 FROZEN-1 §3「.env 已存在永不覆盖」的更强形式。
    tx_env_generate
  fi
  tx_load_env
  # .env 现在一定存在（刚生成或复用），compose 的 --env-file 必须跟着更新。
  tx_prepare_compose_args
  tx_log "拉取镜像：$TX_PANEL_IMAGE"
  tx_pull "$TX_PANEL_IMAGE" || tx_fail "$TX_E_RUNTIME" "docker pull 失败：$TX_PANEL_IMAGE（本机未做任何变更）"
  tx_log "启动全套服务（mysql/redis/db-migrate/backend/worker/web）"
  tx_compose up -d || tx_fail "$TX_E_RUNTIME" "compose up 失败 —— docker compose -p $TX_COMPOSE_PROJECT -f $TX_COMPOSE_FILE ps"
  tx_wait_migrate || tx_fail "$TX_E_RUNTIME" "db-migrate 未以退出码 0 结束：迁移失败即视为部署失败（安装器不自己跑 prisma）"
  tx_wait_healthy || tx_fail "$TX_E_RUNTIME" "健康验收未通过：docker logs tunex-backend / docker compose ps"
  tx_history_append "$TX_PANEL_IMAGE" "$(tx_image_digest "$TX_PANEL_IMAGE")" "install"
  tx_print_handoff
  tx_log "install 完成：$TX_PANEL_IMAGE"
}

tx_action_upgrade() {
  tx_log "动作=upgrade（备份 → 切镜像 → up -d → 迁移/健康 → 失败回退）"
  tx_resolve_images
  tx_preflight upgrade
  tx_prepare_compose_args
  local state
  TX_ENV_IMAGE_VALUE="$(tx_env_current_image)"
  state="$(tx_deploy_state)"
  if [ "$state" = "none" ] || [ "$state" = "partial" ]; then
    tx_fail "$TX_E_STATE" "upgrade 拒绝：没有可升级的运行中部署（状态=$state）。首次部署请用 sudo $TX_SELF install --version <sha>"
  fi
  tx_log "当前 TUNEX_IMAGE=${TX_ENV_IMAGE_VALUE:-未设置} → 目标 $TX_PANEL_IMAGE"
  tx_log "[1/6] 先拉取目标镜像（先 pull、后变更：拉不到就到此为止，镜像与数据都没动）"
  tx_pull "$TX_PANEL_IMAGE" || tx_fail "$TX_E_RUNTIME" "docker pull 失败：$TX_PANEL_IMAGE（未改动 .env，镜像与数据保持原状）"
  tx_log "[2/6] 备份前置（调用既有 scripts/ops/backup.sh；失败即拒绝升级，不留无保护窗口）"
  tx_backup_required || tx_fail "$TX_E_RUNTIME" "备份失败 —— upgrade 已拒绝，未切换任何镜像"
  tx_log "[3/6] 写 .env（仅 TUNEX_IMAGE / TUNEX_AGENT_IMAGE / TUNEX_AGENT_LATEST_VERSION）"
  if [ "$TX_DRY_RUN" -eq 1 ]; then
    printf '[dry-run] 备份 %s → %s 后改写 TUNEX_IMAGE=%s\n' "$TX_ENV_FILE" "$TX_OPS_DIR/.env.before-installer-upgrade" "$TX_PANEL_IMAGE"
  else
    mkdir -p "$TX_OPS_DIR"
    cp "$TX_ENV_FILE" "$TX_OPS_DIR/.env.before-installer-upgrade"
    tx_env_set "$TX_ENV_FILE" "TUNEX_IMAGE" "$TX_PANEL_IMAGE"
    if [ -n "$TX_AGENT_IMAGE_RESOLVED" ]; then tx_env_set "$TX_ENV_FILE" "TUNEX_AGENT_IMAGE" "$TX_AGENT_IMAGE_RESOLVED"; fi
    if [ -n "$TX_AGENT_LATEST_VERSION_VALUE" ]; then
      tx_env_set "$TX_ENV_FILE" "TUNEX_AGENT_LATEST_VERSION" "$TX_AGENT_LATEST_VERSION_VALUE"
    fi
  fi
  tx_load_env
  tx_prepare_compose_args
  tx_log "[4/6] up -d $TX_APP_SERVICES（mysql/redis 不动）"
  if tx_apply_and_verify; then
    tx_history_append "$TX_PANEL_IMAGE" "$(tx_image_digest "$TX_PANEL_IMAGE")" "upgrade"
    tx_log "[6/6] upgrade 成功：$TX_PANEL_IMAGE"
    tx_print_node_upgrade_reminder
    return 0
  fi
  tx_warn "[5/6] 升级未通过健康/迁移验收 → 调用既有 scripts/ops/rollback.sh --to previous --yes（只回退镜像）"
  tx_rollback_to_previous || tx_fail "$TX_E_RUNTIME" \
    "自动回退也失败：请人工介入 —— scripts/ops/rollback.sh --to previous --yes；数据层退回必须人工 scripts/ops/restore.sh <backup-id> --yes"
  tx_fail "$TX_E_RUNTIME" "upgrade 失败，已自动回退到上一版本（数据层未回退；如需一并退回数据，人工执行 scripts/ops/restore.sh <backup-id> --yes）"
}

tx_apply_and_verify() {
  tx_compose up -d $TX_APP_SERVICES || return 1
  tx_wait_migrate || return 1
  tx_wait_healthy || return 1
  return 0
}

tx_backup_required() {
  local bs="$TX_PROJECT_ROOT/scripts/ops/backup.sh" before after
  [ -f "$bs" ] || { tx_err "缺少既有备份脚本：$bs（FROZEN-6：备份是 OPS-02 的职责，安装器不复刻）"; return 1; }
  before="$(tx_backup_manifest_count)"
  # 口令只经环境变量传递给子进程：不进 argv、不进日志、不进任何文件（与 F5.8 同款纪律）。
  export BACKUP_PASSPHRASE
  tx_run env COMPOSE_FILE="$TX_COMPOSE_FILE" COMPOSE_PROJECT_NAME="$TX_COMPOSE_PROJECT" \
    BACKUP_DIR="$TX_BACKUP_DIR" "$bs" || return 1
  if [ "$TX_DRY_RUN" -eq 1 ]; then
    # 夹具 backup_result=fail 模拟"backup.sh 非 0 / 成功但没产出新 manifest"两种失败
    if [ "$(tx_fixture backup_result ok)" != "ok" ]; then
      tx_err "备份失败（夹具 backup_result）：拒绝升级，不留无保护窗口"
      return 1
    fi
    return 0
  fi
  after="$(tx_backup_manifest_count)"
  if [ "${after:-0}" -le "${before:-0}" ]; then
    tx_err "backup.sh 返回 0 但 $TX_BACKUP_DIR 下没有新增 manifest —— 拒绝认为\"已备份\""
    return 1
  fi
  return 0
}

tx_rollback_to_previous() {
  local rb="$TX_PROJECT_ROOT/scripts/ops/rollback.sh"
  [ -f "$rb" ] || { tx_err "缺少既有回滚脚本：$rb"; return 1; }
  export BACKUP_PASSPHRASE
  tx_run env COMPOSE_FILE="$TX_COMPOSE_FILE" COMPOSE_PROJECT_NAME="$TX_COMPOSE_PROJECT" \
    TUNEX_ENV_FILE="$TX_ENV_FILE" OPS_DIR="$TX_OPS_DIR" "$rb" --to previous --yes
}

tx_action_uninstall() {
  tx_log "动作=uninstall（默认保留数据卷）"
  tx_preflight uninstall
  tx_prepare_compose_args
  if [ "$TX_PURGE_DATA" -eq 1 ] && [ "$TX_ASSUME_YES" -ne 1 ]; then
    if [ -t 0 ] && [ "$TX_DRY_RUN" -ne 1 ]; then
      printf '[installer] --purge-data 会**删除数据卷**（MySQL/Redis 数据不可恢复）。输入 yes 继续: '
      local answer=""; read -r answer || true
      [ "$answer" = "yes" ] || tx_fail "$TX_E_USAGE" "未确认，已取消（数据卷未动）"
    else
      tx_fail "$TX_E_USAGE" "--purge-data 在非交互环境必须同时给 --yes（会删除 tunex-mysql-data-prod / tunex-redis-data-prod，不可恢复）"
    fi
  fi
  if [ "$TX_PURGE_DATA" -eq 1 ]; then
    tx_log "停止并删除容器 + 数据卷（--purge-data --yes）"
    tx_compose down -v || tx_fail "$TX_E_RUNTIME" "compose down -v 失败"
    tx_log "数据卷已删除：tunex-mysql-data-prod / tunex-redis-data-prod"
  else
    tx_log "停止并删除容器（数据卷保留）"
    tx_compose down || tx_fail "$TX_E_RUNTIME" "compose down 失败"
    tx_log "数据卷保留：tunex-mysql-data-prod / tunex-redis-data-prod（要一并删除用 --purge-data --yes）"
  fi
  tx_log "配置文件保留在 $TX_ENV_FILE（本脚本不删配置；要重来请人工处理）"
  tx_log "如需恢复数据：scripts/ops/restore.sh <backup-id> --yes（全毁式二次确认，OPS-02 职责）"
}

tx_action_status() {
  tx_log "动作=status（只读：不写任何文件、不改任何容器）"
  tx_prepare_compose_args
  printf '[installer] 部署目录   : %s\n' "$TX_PROJECT_ROOT"
  printf '[installer] compose    : %s%s\n' "$TX_COMPOSE_FILE" "${TX_STANDALONE_FLAGS:+ (+$TX_STANDALONE_FLAGS)}"
  printf '[installer] 项目名     : %s\n' "$TX_COMPOSE_PROJECT"
  printf '[installer] .env       : %s\n' "$TX_ENV_FILE"
  local findings=""
  if [ -f "$TX_ENV_FILE" ]; then
    findings="$(tx_env_validate "$TX_ENV_FILE" || true)"
    if [ -z "$findings" ]; then
      printf '[installer] .env 校验  : ok（必需键齐全、非占位值、权限 600）\n'
    else
      printf '[installer] .env 校验  : 有问题\n'
      tx_env_report_findings "$TX_ENV_FILE" $findings
    fi
    tx_load_env
    tx_prepare_compose_args
    printf '[installer] TUNEX_IMAGE: %s\n' "$(tx_env_get "$TX_ENV_FILE" TUNEX_IMAGE)"
    printf '[installer] TUNEX_AGENT_IMAGE: %s\n' "$(tx_env_get "$TX_ENV_FILE" TUNEX_AGENT_IMAGE)"
  else
    printf '[installer] .env 校验  : 不存在（本机还没有安装过）\n'
  fi
  if [ "$TX_DRY_RUN" -eq 1 ]; then
    printf '[dry-run] %s\n' "$(tx_quote_cmd docker compose -p "$TX_COMPOSE_PROJECT" $TX_STANDALONE_FLAGS -f "$TX_COMPOSE_FILE" $TX_ENVFILE_FLAGS ps -a)"
    printf '[installer] 健康       : /healthz=%s /readyz=%s\n' "$(tx_fixture health_http 200)" "$(tx_fixture ready_http 200)"
  elif tx_docker_present && tx_compose_available; then
    # docker CLI 在、但守护进程不可达（未加入 docker 组 / socket 不通）是常态：
    # status 必须继续降级打印事实，而不是被 set -e 打死。
    tx_log "容器："
    if ! tx_compose_capture ps -a 2>/dev/null | sed 's/^/  /'; then
      tx_warn "读不到容器列表（docker 守护进程不可达？）—— 只打印文件系统事实"
    fi
    local backend_img=""
    backend_img="$(docker inspect -f '{{.Config.Image}}' tunex-backend 2>/dev/null || true)"
    if [ -n "$backend_img" ]; then
      printf '[installer] 运行中的 backend 镜像: %s\n' "$backend_img"
      printf '[installer] 实际 digest（RepoDigests）: %s\n' "$(tx_image_digest "$backend_img")"
    elif [ -n "${TUNEX_IMAGE:-}" ]; then
      printf '[installer] 实际 digest（RepoDigests）: %s\n' "$(tx_image_digest "$TUNEX_IMAGE")"
    else
      printf '[installer] 实际 digest（RepoDigests）: （无部署）\n'
    fi
    printf '[installer] 健康       : /healthz=%s /readyz=%s\n' \
      "$(tx_http_code "$(tx_health_url)")" "$(tx_http_code "$(tx_ready_url)")"
    local mig_cid mig_state mig_exit
    mig_cid="$(docker ps -a --filter "label=com.docker.compose.project=$TX_COMPOSE_PROJECT" --filter "name=tunex-$TX_MIGRATE_SERVICE" --format '{{.ID}}' 2>/dev/null | head -1 || true)"
    if [ -n "$mig_cid" ]; then
      mig_state="$(docker inspect -f '{{.State.Status}}' "$mig_cid" 2>/dev/null || printf unknown)"
      mig_exit="$(docker inspect -f '{{.State.ExitCode}}' "$mig_cid" 2>/dev/null || printf unknown)"
      printf '[installer] db-migrate: status=%s exit=%s\n' "$mig_state" "$mig_exit"
    else
      printf '[installer] db-migrate: 没有该容器\n'
    fi
  else
    tx_warn "Docker 不可用，只打印文件系统事实："
    tx_docker_guidance /etc/os-release >&2
  fi
  local last_manifest last_backup hist
  last_manifest="$(find "$TX_BACKUP_DIR" -name '*.manifest.json' 2>/dev/null | sort | tail -1 || true)"
  printf '[installer] 最近备份   : %s\n' "${last_manifest:-（无）}"
  printf '[installer] 备份份数   : %s\n' "$(tx_backup_manifest_count)"
  if [ -s "$TX_OPS_DIR/deploy-history.jsonl" ]; then
    printf '[installer] 部署历史（最近 3 条）：\n'
    tail -3 "$TX_OPS_DIR/deploy-history.jsonl" | sed 's/^/  /'
  else
    printf '[installer] 部署历史   : （无）\n'
  fi
  tx_print_node_upgrade_reminder
  if [ -n "$findings" ]; then return "$TX_E_ENV"; fi
  return 0
}

# =============================================================================
# 交接提示（安装器只打印，不写 crontab、不代管日常运维）
# =============================================================================
tx_print_handoff() {
  tx_log "交接给 OPS-02（日常运维不属于安装器）："
  printf '  · 备份节律（口令来自 .env（600）或 cron 环境变量；完整口径见 docs/production-deploy.md §5）：\n'
  printf '      15 2 * * * cd %s && COMPOSE_FILE=%s scripts/ops/backup.sh >> %s/cron.log 2>&1\n' \
    "$TX_PROJECT_ROOT" "$TX_COMPOSE_FILE" "$TX_BACKUP_DIR"
  printf '  · 告警 / 容量：\n'
  printf '      */5 * * * * cd %s && COMPOSE_FILE=%s scripts/ops/alert.sh >> %s/cron.log 2>&1\n' \
    "$TX_PROJECT_ROOT" "$TX_COMPOSE_FILE" "$TX_PROJECT_ROOT/var/alerts"
  printf '      30 3 * * * cd %s && COMPOSE_FILE=%s scripts/ops/capacity.sh >> %s/cron.log 2>&1\n' \
    "$TX_PROJECT_ROOT" "$TX_COMPOSE_FILE" "$TX_OPS_DIR"
  printf '  · 巡检： sudo %s status\n' "$TX_SELF"
  tx_print_node_upgrade_reminder
}

tx_print_node_upgrade_reminder() {
  tx_log "节点 Agent 不随面板主机升级（FROZEN-2）：请在面板生成命令执行 ——"
  printf '  · 新节点安装： POST /api/nodes/:id/enrollment（一次性 token，TTL 600s）\n'
  printf '  · 节点升级： POST /api/nodes/:id/upgrade-command\n'
}

# =============================================================================
# main
# =============================================================================
tx_main() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      install|upgrade|uninstall|status)
        [ -z "$TX_ACTION" ] || tx_fail "$TX_E_USAGE" "动作重复：$TX_ACTION / $1"
        TX_ACTION="$1"; shift ;;
      --version)      TX_VERSION="${2:?--version 需要参数}"; shift 2 ;;
      --agent-image)  TX_AGENT_IMAGE_OPT="${2:?--agent-image 需要参数}"; shift 2 ;;
      --allow-floating) TX_ALLOW_FLOATING=1; shift ;;
      --standalone)   TX_STANDALONE=1; shift ;;
      --purge-data)   TX_PURGE_DATA=1; shift ;;
      --reuse-env)    TX_REUSE_ENV=1; shift ;;
      --yes|-y)       TX_ASSUME_YES=1; shift ;;
      --dry-run)      TX_DRY_RUN=1; shift ;;
      --check)        TX_CHECK=1; shift ;;
      --no-docker)    TX_NO_DOCKER=1; shift ;;
      --help|-h)      tx_usage 0 ;;
      *)              tx_fail "$TX_E_USAGE" "未知参数: $1（用法见 --help）" ;;
    esac
  done
  [ -n "$TX_ACTION" ] || tx_usage "$TX_E_USAGE"
  if [ "$TX_NO_DOCKER" -eq 1 ] && [ "$TX_DRY_RUN" -ne 1 ] && [ "$TX_CHECK" -ne 1 ]; then
    tx_fail "$TX_E_USAGE" "--no-docker 只允许与 --dry-run 或 --check 合用（真实部署必须真的检测 Docker）"
  fi
  if [ "$TX_REUSE_ENV" -eq 1 ] && [ "$TX_ACTION" != "install" ]; then
    tx_fail "$TX_E_USAGE" "--reuse-env 只对 install 有意义（当前动作：$TX_ACTION）"
  fi

  case "$TX_ACTION" in
    install)   tx_action_install ;;
    upgrade)   tx_action_upgrade ;;
    uninstall) tx_action_uninstall ;;
    status)    tx_action_status ;;
  esac
  # --check 已在前置检查结束时退出（tx_after_preflight）；能走到这里说明是真实动作。
  exit 0
}

if [ "$TX_SOURCED" -eq 0 ]; then
  tx_main "$@"
fi
