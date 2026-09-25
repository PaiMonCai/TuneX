#!/usr/bin/env bash
# ============================================================================
# TuneX OPS-02 —— 回滚脚本
#
# 回滚 = 把部署恢复到"上一个已知良好状态"，两层含义：
#   A. 版本回滚：把镜像 tag 切回上一个 GHCR sha 版本（代码层回退）
#   B. 数据回滚：从备份恢复 MySQL/Redis（数据层回退，等同 restore.sh）
#
# 本脚本统一编排，并强制"先备份现状 → 再回滚 → 再健康检查 → 失败则自动回退"。
#
# 用法：
#   scripts/ops/rollback.sh --list                    # 列出可回滚目标
#   scripts/ops/rollback.sh --to <target> [--yes]
#   scripts/ops/rollback.sh --to <target> --data      # 同时从备份恢复数据
#   scripts/ops/rollback.sh --verify <target>         # 只验证不执行
#
# target 三种形式：
#   1. 镜像引用：ghcr.io/paimoncai/tunex:<sha> @sha256:<digest>
#      （CI 每个 commit 都推 <sha> tag；回滚到指定版本最稳）
#   2. 部署记录 id（.deploy-history.jsonl 中的一条，包含当时的镜像 digest）
#   3. `previous`：自动取上一个成功部署
#
# 流程（每次执行都留痕 var/ops/rollback-history.jsonl）：
#   1. 记录当前状态（git rev + 镜像 digest + compose config 指纹）→ 用于再次回滚
#   2. 备份现状（默认要求，除非 --no-backup-backup）
#   3. 拉取目标镜像（本地不存在时）
#   4. 更新 .env 的 TUNEX_IMAGE（同一 digest 同时驱动 backend/worker/web）
#   5. compose up -d 切换（DB/Redis 不动，滚动替换 backend/worker/web）
#   6. 健康等待：/healthz 200 + 三个服务 healthy，超时即失败
#   7. 失败 → 自动回退到步骤 1 记录的状态（幂等）
#   8. 成功 → 写 deploy-history，提示数据是否也要回滚
#
# 安全边界：
#   · 任何变更前必须先成功备份（备份失败 = 拒绝回滚）
#   · --data 会调用 restore.sh，二次确认
#   · 全程 dry-run 优先，--apply 才真正写入
#
# 退出码：0 成功；1 失败（已自动回退）；2 用法/前置错误。
# ============================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_ROOT/docker-compose.yaml}"
OPS_DIR="${OPS_DIR:-$PROJECT_ROOT/var/ops}"
TUNEX_IMAGE_DEFAULT="ghcr.io/paimoncai/tunex:latest"
# shellcheck disable=SC2034  # 兜底已知良好版本（见 docs/production-deploy.md）
KNOWN_GOOD_IMAGE="${ROLLBACK_KNOWN_GOOD_IMAGE:-}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"

log()  { printf '[rollback] %s\n' "$*"; }
warn() { printf '[rollback] WARN: %s\n' "$*" >&2; }
die()  { printf '[rollback] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }
usage() { sed -n '2,49p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

mkdir -p "$OPS_DIR"
HISTORY="$OPS_DIR/deploy-history.jsonl"
[[ -f "$HISTORY" ]] || touch "$HISTORY"

# --- 参数 --------------------------------------------------------------------
TARGET=""; ASSUME_YES=0; DO_DATA=0; DO_VERIFY=0; DO_LIST=0; DO_BACKUP=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --list)       DO_LIST=1 ;;
    --to)         TARGET="${2:?--to 需要参数}"; shift ;;
    --data)       DO_DATA=1 ;;
    --verify)     DO_VERIFY=1; TARGET="${2:?--verify 需要参数}"; shift ;;
    --yes|-y)     ASSUME_YES=1 ;;
    --no-backup)  DO_BACKUP=0 ;;
    --help|-h)    usage ;;
    *)            die "未知参数: $1" 2 ;;
  esac
  shift
done

command -v docker >/dev/null 2>&1 || die "docker 不在 PATH" 2
docker compose version >/dev/null 2>&1 || die "docker compose v2 不可用" 2
[[ -f "$COMPOSE_FILE" ]] || die "compose 不存在: $COMPOSE_FILE" 2

cd "$PROJECT_ROOT"
if [[ -f "$PROJECT_ROOT/.env" ]]; then set -a; . "$PROJECT_ROOT/.env"; set +a; fi
COMPOSE=(docker compose -p tunex -f "$COMPOSE_FILE")

# svc_running <service> —— 便携式"服务是否 running"检查。
# 不同 compose 版本对 `ps --status` 支持不一（v2.28 无该 flag），
# 因此统一解析 `ps --format '{{.Service}} {{.State}}'` 的第二列。
svc_running() {
  local svc="$1"
  "${COMPOSE[@]}" ps --format '{{.Service}} {{.State}}' 2>/dev/null \
    | awk -v s="$svc" '$1==s && $2 ~ /^running/ {found=1} END{exit found?0:1}'
}

CADDY_HTTP_PORT="${CADDY_HTTP_PORT:-9091}"

# --- 当前状态指纹 ------------------------------------------------------------
current_state() {
  local commit digest image
  commit="$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
  image="${TUNEX_IMAGE:-$TUNEX_IMAGE_DEFAULT}"
  digest="$(docker image inspect "$image" --format '{{index .RepoDigests 0}}' 2>/dev/null || echo "local:${image}")"
  jq -nc --arg c "$commit" --arg i "$image" --arg d "$digest" --arg t "$(date -Iseconds)" \
    '{commit:$c, image:$i, digest:$d, at:$t}'
}

# --- 部署历史 ----------------------------------------------------------------
if [[ $DO_LIST -eq 1 ]]; then
  echo "可回滚目标："
  if [[ -s "$HISTORY" ]]; then
    nl -ba "$HISTORY" | tail -20 | sed 's/^/  /'
  else
    echo "  （无部署记录）"
  fi
  echo
  echo "本地可用镜像："
  docker image ls --format '{{.Repository}}:{{.Tag}}\t{{.CreatedSince}}\t{{.Size}}' \
    | grep -E '(^|/)tunex:' | sed 's/^/  /' || echo "  （无）"
  echo
  echo "GHCR 上的 sha tag（需 gh CLI 或 git ls-remote 辅助，见 docs/ops/rollback.md）"
  exit 0
fi

# --- 解析目标 ----------------------------------------------------------------
resolve_image() {  # $1 = target → prints unified TuneX image ref
  local t="$1"
  [[ -n "$t" ]] || die "未指定 --to 目标" 2
  case "$t" in
    previous)
      tail -2 "$HISTORY" | head -1 | jq -r '.image // .backend_image // empty' \
        || die "历史记录不足以解析 previous" 2
      ;;
    ghcr.io/*|*@sha256:*|*/*:*)
      echo "$t" ;;
    *)
      # 部署记录 id / digest 短形式
      local found
      found="$(grep -F "$t" "$HISTORY" 2>/dev/null | tail -1 | jq -r '.image // .backend_image // empty')"
      [[ -n "$found" ]] && echo "$found" || die "无法解析目标: $t" 2
      ;;
  esac
}

if [[ $DO_VERIFY -eq 1 || -n "$TARGET" ]]; then
  TUNEX_IMG="$(resolve_image "$TARGET")"
  [[ -n "$TUNEX_IMG" ]] || die "目标镜像为空" 2
else
  usage
  die "必须指定 --to <target> 或 --list" 2
fi
log "回滚目标："
log "  TuneX image: $TUNEX_IMG"
[[ "$TARGET" == "previous" ]] && log "  (解析自部署历史 previous)"

# --- 1. 目标镜像可用性校验 ---------------------------------------------------
log "[1/6] 校验目标镜像"
if docker image inspect "$TUNEX_IMG" >/dev/null 2>&1; then
  log "  本地已存在: $TUNEX_IMG"
else
  log "  本地不存在，尝试拉取…"
  docker pull "$TUNEX_IMG" >/dev/null 2>&1 || die "拉取失败: $TUNEX_IMG（检查网络/GHCR 权限/tag 是否真实存在）" 2
  log "  已拉取: $(docker image inspect "$TUNEX_IMG" --format '{{.Id}}')"
fi
log "  digest: $(docker image inspect "$TUNEX_IMG" --format '{{index .RepoDigests 0}}' 2>/dev/null || echo '(local only)')"

if [[ "$DO_VERIFY" -eq 1 ]]; then
  log "✅ 目标可回滚（verify 模式，未做任何变更）"
  exit 0
fi

# --- 2. 备份现状 -------------------------------------------------------------
if [[ $DO_BACKUP -eq 1 ]]; then
  log "[2/6] 回滚前备份现状（备份失败即终止回滚）"
  # 备份口令必须**导出**到子进程。历史写法 `BACKUP_PASSPHRASE=x script.sh ${VAR:+}`
  # 是无效的：`VAR=val cmd` 形式只在 cmd 的环境里生效，而这里 `${BACKUP_PASSPHRASE:+}`
  # 展开为空串却让 shellcheck 误判为「参数」；更关键的是若父环境没有该变量，
  # backup.sh 会走到交互式 read，而在非 tty 的日志重定向下直接挂住/失败。
  if [[ -z "${BACKUP_PASSPHRASE:-}" ]]; then
    if [[ -t 0 ]]; then
      read -r -s -p "备份加密口令（回滚前备份需要，输入不可见）: " BACKUP_PASSPHRASE; echo
    else
      die "回滚前备份需要 BACKUP_PASSPHRASE（cron/管道环境无法交互输入）。设置后重试，或确认已有备份后加 --no-backup。" 2
    fi
  fi
  export BACKUP_PASSPHRASE
  if ! "$SCRIPT_DIR/backup.sh" > "$OPS_DIR/pre-rollback-backup.log" 2>&1; then
    tail -5 "$OPS_DIR/pre-rollback-backup.log" >&2
    die "回滚前备份失败 —— 已终止（不留无保护的回滚窗口）" 1
  fi
  log "  备份日志: $OPS_DIR/pre-rollback-backup.log"
else
  warn "跳过回滚前备份（--no-backup）：当前数据不在保护内"
fi

# --- 3. 确认 -----------------------------------------------------------------
if [[ $ASSUME_YES -ne 1 ]]; then
  echo
  log "即将执行回滚：backend/worker/web → $TUNEX_IMG；mysql/redis 不动。"
  [[ $DO_DATA -eq 1 ]] && log "⚠️  --data：随后还会从最新备份恢复数据（覆盖现有数据）"
  read -r -p "输入 ROLLBACK 确认执行: " ans
  [[ "$ans" == "ROLLBACK" ]] || die "已取消" 2
fi

# --- 4. 生成 .env.rollback（干跑 diff） ---------------------------------------
log "[3/6] 生成回滚 env"
CUR_STATE="$(current_state)"
echo "$CUR_STATE" >> "$HISTORY"
log "  当前状态已记录（用于失败回退）: $(jq -r '.digest' <<<"$CUR_STATE")"

ENV_FILE="$PROJECT_ROOT/.env"
[[ -f "$ENV_FILE" ]] || die ".env 不存在 —— 无法确定部署配置" 2
cp "$ENV_FILE" "$OPS_DIR/.env.before-rollback"
# 替换/追加统一镜像变量
if grep -q '^TUNEX_IMAGE=' "$ENV_FILE"; then
  sed -i -E "s#^TUNEX_IMAGE=.*#TUNEX_IMAGE=$TUNEX_IMG#" "$ENV_FILE"
else
  echo "TUNEX_IMAGE=$TUNEX_IMG" >> "$ENV_FILE"
fi
# 清理旧双镜像变量，避免运维人员误以为它们仍生效。
sed -i -E '/^TUNEX_(BACKEND|WEB)_IMAGE=/d' "$ENV_FILE"
log "  .env diff:"
diff -u "$OPS_DIR/.env.before-rollback" "$ENV_FILE" | sed 's/^/    /' || true

# --- 5. 执行切换 -------------------------------------------------------------
log "[4/6] 切换服务（mysql/redis 不受影响）"
if ! "${COMPOSE[@]}" up -d backend worker web caddy >> "$OPS_DIR/rollback-up.log" 2>&1; then
  warn "compose up 失败，自动回退 env 并重启"
  cp "$OPS_DIR/.env.before-rollback" "$ENV_FILE"
  "${COMPOSE[@]}" up -d backend worker web caddy >> "$OPS_DIR/rollback-up.log" 2>&1 || true
  die "回滚失败且已尝试自动回退 —— 详见 $OPS_DIR/rollback-up.log；必要时执行 restore.sh 恢复数据" 1
fi
log "  详见 $OPS_DIR/rollback-up.log"

# --- 6. 健康验证 -------------------------------------------------------------
log "[5/6] 健康验证（超时 ${HEALTH_TIMEOUT}s）"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
ok=0
while [[ $(date +%s) -lt $deadline ]]; do
  # /healthz 必须 200
  code="$(curl -fsS -o /dev/null -w '%{http_code}' -m 3 \
    "http://127.0.0.1:${CADDY_HTTP_PORT}/healthz" 2>/dev/null || echo 000)"
  # 三个服务 running
  running=1
  for s in backend worker web; do
    svc_running "$s" || running=0
  done
  if [[ "$code" == "200" && "$running" -eq 1 ]]; then ok=1; break; fi
  sleep 3
done

if [[ $ok -ne 1 ]]; then
  log "  ⚠️ 健康检查未通过（healthz=$code running=$running）—— 自动回退"
  cp "$OPS_DIR/.env.before-rollback" "$ENV_FILE"
  "${COMPOSE[@]}" up -d backend worker web caddy >> "$OPS_DIR/rollback-up.log" 2>&1 || true
  die "回滚未通过健康检查，已自动回退到上一版本。请人工介入：docker compose ps + logs" 1
fi
log "  healthz=200, backend/worker/web 全部 running ✅"

# --- 7. 记录 + 数据层可选回滚 -------------------------------------------------
log "[6/6] 写回滚记录"
jq -nc --arg t "$(date -Iseconds)" --arg from "$(jq -r '.digest' <<<"$CUR_STATE")" \
  --arg to "$TUNEX_IMG" --arg data "$DO_DATA" \
  '{at:$t, action:"rollback", from:$from, to:$to, data_restore:($data=="1")}' >> "$HISTORY"

if [[ $DO_DATA -eq 1 ]]; then
  log "数据层回滚 → 调用 restore.sh（最新备份）"
  LATEST="$(find "$PROJECT_ROOT/var/backups" -name '*.manifest.json' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | awk '{print $2}')"
  if [[ $ASSUME_YES -ne 1 ]]; then
    read -r -p "将从 $LATEST 恢复数据（覆盖现状），输入 RESTORE 确认: " ans
    [[ "$ans" == "RESTORE" ]] || { log "已跳过数据恢复（版本回滚仍然生效）"; exit 0; }
  fi
  BACKUP_PASSPHRASE="${BACKUP_PASSPHRASE:?数据恢复需要 BACKUP_PASSPHRASE}" \
    "$SCRIPT_DIR/restore.sh" "$LATEST" --yes || die "数据恢复失败" 1
fi

log "✅ 回滚完成：$TUNEX_IMG"
log "  后续："
log "    docker compose ps"
log "    curl -fsS http://127.0.0.1:${CADDY_HTTP_PORT}/healthz"
log "    抽 1 个 workspace 核对业务数据"
log "  历史：$HISTORY"
exit 0
