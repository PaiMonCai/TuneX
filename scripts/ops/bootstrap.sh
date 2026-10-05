#!/usr/bin/env bash
# =============================================================================
# TuneX WP21 —— 安装器引导段（把仓库按明确版本检出到部署目录，然后交给安装器）
#
# 语义权威：docs/v5-wp21-installer-and-docs-site-contract.md
#   FROZEN-3 第 1 段「引导段」、§4.0 OPEN-1 裁决（2026-10-05 修订版）、§11 实现记录。
#
# 引导段只做三件事：
#   1. 按**明确的版本**把仓库检出到部署目录；   2. 断言检出的 HEAD 就是该版本；
#   3. exec 检出后的 scripts/ops/install.sh（有副作用的动作全部发生在已验证的代码上）。
# 引导段**不做**：写 .env、拉镜像、up -d、装 Docker、读/写任何凭据。
#
# 版本形态决定检索方式（§4.0 裁决；实测证据见契约 §11）：
#   · 裸 SHA（^[0-9a-f]{7,40}$）→ `git clone <repo> <dir>` + `git checkout --detach <sha>`
#     （**完整克隆**：`--depth 1 --branch <裸 sha>` 必然 fatal，`fetch --depth 1 origin <sha>`
#      依赖远端 uploadpack.allowAnySHA1InWant，默认关闭 —— 两条都禁止）
#   · ref（tag / branch）→ `git ls-remote` 先解析出 sha，再 `git clone --depth 1 --single-branch
#     --branch <ref>`，并用解析出的 sha 做断言（防止"浅克隆完就换成别的 commit"）
# 两条路径都以 `git rev-parse HEAD` 断言收尾；不相等 → 删掉本次创建的目录 + 非零退出。
#
# 用法：
#   sudo scripts/ops/bootstrap.sh --repo <git-url> --version <sha|ref> [--dir /opt/TuneX]
#   sudo scripts/ops/bootstrap.sh --repo <git-url> --version <sha|ref> --action upgrade \
#        [--dir /opt/TuneX] [-- <install.sh 的额外参数>]
#   scripts/ops/bootstrap.sh --repo <url> --version <sha> --dry-run   # 只打印计划，零副作用
#   scripts/ops/bootstrap.sh --repo <url> --version <sha> --check     # 真克隆+断言，但**不** exec
#
# 退出码：2 用法/参数；3 缺 git 或远端不可达；4 检出/断言失败；5 目标目录已存在且版本不符。
# =============================================================================
set -Eeuo pipefail

TX_E_USAGE=2
TX_E_PREREQ=3
TX_E_CHECKOUT=4
TX_E_TARGET=5

TX_ACTION="install"
TX_REPO=""
TX_VERSION=""
TX_DIR="/opt/TuneX"
TX_DRY_RUN=0
TX_CHECK=0

tx_log()  { printf '[bootstrap] %s\n' "$*"; }
tx_warn() { printf '[bootstrap] WARN: %s\n' "$*" >&2; }
tx_err()  { printf '[bootstrap] ERROR: %s\n' "$*" >&2; }
tx_die()  { tx_err "$2"; exit "$1"; }

tx_usage() {
  awk 'NR==1{next} /^set -Eeuo pipefail/{exit} {sub(/^# ?/,""); print}' "${BASH_SOURCE[0]}"
  exit "${1:-0}"
}

tx_quote_cmd() {
  local out="" a
  for a in "$@"; do out="$out $(printf '%q' "$a")"; done
  printf '%s' "${out# }"
}

# --- 版本形态（可断言：纯函数） ----------------------------------------------
# 裸 SHA：7–40 位十六进制。短 sha 也是合法输入（断言退化为前缀比较）。
tx_version_shape() { # <version> → sha | ref
  case "$1" in
    *[!0-9a-f]*) printf 'ref' ;;
    *)
      if [ "${#1}" -ge 7 ] && [ "${#1}" -le 40 ]; then printf 'sha'; else printf 'ref'; fi
      ;;
  esac
}

# 断言 `<head>` 与 `<expected>` 相等（短 sha 用前缀比较）。0=相等，1=不等。
tx_sha_matches() { # <head> <expected>
  local head="$1" want="$2"
  if [ "${#want}" -eq 40 ]; then
    [ "$head" = "$want" ]
    return $?
  fi
  case "$head" in
    "$want"*) return 0 ;;
    *) return 1 ;;
  esac
}

# --- 前置 --------------------------------------------------------------------
tx_preflight() {
  command -v git >/dev/null 2>&1 || tx_die "$TX_E_PREREQ" "缺少 git：引导段用 git 按版本检出（安装前提，不是运行时依赖）"
  [ -n "$TX_REPO" ] || tx_die "$TX_E_USAGE" "--repo <git-url> 必填"
  [ -n "$TX_VERSION" ] || tx_die "$TX_E_USAGE" "--version <sha|ref> 必填（锚定明确版本；不接受缺省分支）"
  case "$TX_VERSION" in
    latest|main|master|HEAD)
      tx_die "$TX_E_USAGE" "版本 '$TX_VERSION' 不是明确版本：裸 SHA 或 tag 才能锚定（自动跟默认分支已被 FROZEN-2 禁止）" ;;
  esac
}

# --- 检出 --------------------------------------------------------------------
# 返回 0 时：$TX_RESOLVED_SHA 已就绪，且 $TX_DIR 的 HEAD == 该版本。
tx_checkout() {
  local shape repo="$TX_REPO" dir="$TX_DIR" want="$TX_VERSION" mode="$1"
  shape="$(tx_version_shape "$want")"
  TX_RESOLVED_SHA=""

  if [ "$mode" = "plan" ]; then
    if [ "$shape" = "sha" ]; then
      tx_log "版本形态 = 裸 SHA → 完整克隆 + 分离检出（不使用 --depth/--branch）"
      printf '[dry-run] %s\n' "$(tx_quote_cmd git clone "$repo" "$dir")"
      printf '[dry-run] %s\n' "$(tx_quote_cmd git -C "$dir" checkout --detach "$want")"
    else
      tx_log "版本形态 = ref（tag/branch）→ 浅克隆前先用 ls-remote 解析 sha"
      printf '[dry-run] %s\n' "$(tx_quote_cmd git ls-remote --exit-code "$repo" "$want")"
      printf '[dry-run] %s\n' "$(tx_quote_cmd git clone --depth 1 --single-branch --branch "$want" "$repo" "$dir")"
    fi
    printf '[dry-run] %s\n' "$(tx_quote_cmd git -C "$dir" rev-parse HEAD) # 必须等于锚定版本"
    return 0
  fi

  # 目标目录：已存在且是同一版本 → 复用；否则拒绝（fail-closed，不静默复用也不自动删）
  if [ -e "$dir" ]; then
    if [ -d "$dir/.git" ]; then
      local head
      head="$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)"
      if [ "$shape" = "sha" ] && [ -n "$head" ] && tx_sha_matches "$head" "$want"; then
        tx_log "部署目录已存在且 HEAD 与请求版本一致（$head），跳过克隆"
        TX_RESOLVED_SHA="$head"
        return 0
      fi
      if [ "$shape" = "ref" ] && [ -n "$head" ]; then
        local remote_sha
        remote_sha="$(git ls-remote --exit-code "$repo" "$want" 2>/dev/null | awk 'NR==1{print $1}')" || true
        if [ -n "$remote_sha" ] && [ "$head" = "$remote_sha" ]; then
          tx_log "部署目录已存在且 HEAD 与 ref '$want' 当前指向的 sha 一致（$head），跳过克隆"
          TX_RESOLVED_SHA="$head"
          return 0
        fi
      fi
    fi
    tx_die "$TX_E_TARGET" "目标目录已存在且不是请求的版本：$dir
  若要在既有部署上升级： cd $dir && sudo scripts/ops/install.sh upgrade --version <sha>
  若要彻底重来：先人工移走该目录（引导段不自动删除任何既有目录）"
  fi

  if [ "$shape" = "sha" ]; then
    tx_log "裸 SHA 形态：完整克隆（不使用 --depth/--single-branch）→ 分离检出 $want"
    git clone "$repo" "$dir" || tx_die "$TX_E_CHECKOUT" "git clone 失败：$repo"
    if ! git -C "$dir" checkout --detach "$want" >/dev/null 2>&1; then
      rm -rf "$dir"
      tx_die "$TX_E_CHECKOUT" "git checkout --detach $want 失败（该 commit 可能不在任何 ref 上，或仓库不可达）—— 已删除本次克隆的目录"
    fi
    local head
    head="$(git -C "$dir" rev-parse HEAD)" || { rm -rf "$dir"; tx_die "$TX_E_CHECKOUT" "无法读取检出后的 HEAD"; }
    if ! tx_sha_matches "$head" "$want"; then
      rm -rf "$dir"
      tx_die "$TX_E_CHECKOUT" "内容寻址断言失败：检出 HEAD=$head != 请求 $want（已删除目录）"
    fi
    TX_RESOLVED_SHA="$head"
    tx_log "已检出并断言通过：$dir @ $TX_RESOLVED_SHA"
    return 0
  fi

  # ref 形态：先解析 ref→sha，再浅克隆，再用解析出的 sha 断言
  local expected
  expected="$(git ls-remote --exit-code "$repo" "$want" 2>/dev/null | awk 'NR==1{print $1}')" \
    || tx_die "$TX_E_PREREQ" "git ls-remote 无法解析 ref '$want'（仓库不可达或 ref 不存在）"
  [ -n "$expected" ] || tx_die "$TX_E_PREREQ" "git ls-remote 未能解析 ref '$want' → sha"
  tx_log "ref '$want' 在远端解析为 $expected"
  git clone --depth 1 --single-branch --branch "$want" "$repo" "$dir" \
    || tx_die "$TX_E_CHECKOUT" "git clone --depth 1 --branch $want 失败：$repo"
  local head2
  head2="$(git -C "$dir" rev-parse HEAD)" || tx_die "$TX_E_CHECKOUT" "无法读取检出后的 HEAD"
  if [ "$head2" != "$expected" ]; then
    rm -rf "$dir"
    tx_die "$TX_E_CHECKOUT" "内容寻址断言失败：ref '$want' 解析为 $expected，但检出 HEAD=$head2（已删除目录）"
  fi
  TX_RESOLVED_SHA="$head2"
  tx_log "已检出并断言通过：$dir @ $TX_RESOLVED_SHA"
  return 0
}

tx_main() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --repo)    TX_REPO="${2:?--repo 需要参数}"; shift 2 ;;
      --version) TX_VERSION="${2:?--version 需要参数}"; shift 2 ;;
      --dir)     TX_DIR="${2:?--dir 需要参数}"; shift 2 ;;
      --action)  TX_ACTION="${2:?--action 需要参数}"; shift 2 ;;
      --dry-run) TX_DRY_RUN=1; shift ;;
      --check)   TX_CHECK=1; shift ;;
      --help|-h) tx_usage 0 ;;
      --)        shift; break ;;
      *)         tx_die "$TX_E_USAGE" "未知参数: $1（用法见 --help）" ;;
    esac
  done

  tx_preflight

  if [ "$TX_DRY_RUN" -eq 1 ]; then
    tx_log "dry-run：以下是引导段会执行的命令（不联网、不写盘）"
    tx_checkout plan
    printf '[dry-run] %s\n' "$(tx_quote_cmd "$TX_DIR/scripts/ops/install.sh" "$TX_ACTION" --version "<解析出的 sha>" "$@")"
    exit 0
  fi

  tx_checkout exec

  local installer="$TX_DIR/scripts/ops/install.sh"
  [ -f "$installer" ] || tx_die "$TX_E_CHECKOUT" "检出内容里没有安装器：$installer（版本 $TX_RESOLVED_SHA 早于 WP21？）"

  if [ "$TX_CHECK" -eq 1 ]; then
    tx_log "check 完成：$TX_DIR @ $TX_RESOLVED_SHA（未 exec 安装器）"
    tx_log "下一步： sudo $installer $TX_ACTION --version $TX_RESOLVED_SHA"
    exit 0
  fi

  tx_log "交接给安装器：$installer $TX_ACTION --version $TX_RESOLVED_SHA"
  # 版本锚用解析出的**完整 sha**（镜像 tag 就是 git sha；ref 形态在这里被固化成 sha）。
  exec "$installer" "$TX_ACTION" --version "$TX_RESOLVED_SHA" "$@"
}

if [ "${BASH_SOURCE[0]:-}" = "${0:-}" ]; then
  tx_main "$@"
fi
