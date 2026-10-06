/**
 * 面板迁移回退（task-44）——**面板侧的唯一真相**：把「备用面板地址 + 迁移 id + 起始时间」
 * 这套配置校验好并渲染成 `agent.env` 的环境行。
 *
 * ── 行为参照声明 ────────────────────────────────────────────────────────────
 * 参照 ForwardX（AGPL-3.0）`server/agentInstallScripts.ts` 的 CONFIG_FILTER：它把
 * `.migrationFallbackPanelUrl` / `.panelMigrationId` / `.panelMigrationStartedAt`
 * 写进 agent 配置，且**两个键齐备才写、否则三个一起删**（可撤销的回退态）。
 * TuneX 侧为**独立实现**：面板侧从**部署环境变量**读这套配置（与 `TUNEX_PUBLIC_PANEL_URL`
 * / `TUNEX_AGENT_LATEST_VERSION` 同一层，都是"部署级事实"，不需要动 schema），
 * 渲染成 agent.env 的 `TUNEX_*` 环境行；凭据模型不变（一次性 token + 哈希凭据与迁移无关）。
 *
 * ── 为什么不是 config 表 ────────────────────────────────────────────────────
 * `config` 表的 `name` 列是 **DB ENUM**（`SystemConfigName`），加一个键就要加一个枚举成员
 * ⇒ 需要 schema 迁移；而 `backend/src/services/__tests__/system-config-enum.test.ts` 会
 * 直接拦下"用了不在枚举里的键"（它是对的：那种键**存不进库、读永远是 null**）。
 * 本切片不动 schema，因此配置面放在环境变量里，并在 `docs/production-deploy.md` 写清。
 *
 * ── 为什么这里也要校验一遍（Go 侧已校验）──────────────────────────────────
 * Agent 侧的 `agentconfig.Config.PanelMigration` 是**运行期**的强制点（它拒绝坏配置并
 * 保持"不切"）。面板侧这一遍是**下发期**的闸门：宁可在这里就把"只填了一半"的配置
 * 拦下来并说清缺什么，也不要把一个坏三元组写进节点主机的 agent.env —— 那会让节点
 * 在面板真的坏掉时才第一次发现"回退地址是空的"。
 *
 * ── 与参照实现的一处刻意偏离 ───────────────────────────────────────────────
 * "齐备才写"在 TuneX 里不只是"写不写"，而是**显式的三态**：未配置 / 已配置 / 配置坏了。
 * 第三种必须能被运维看见（`reason`），不能退化成"当作没配"。
 */
/**
 * 面板侧读取这套配置的三个环境变量名（部署级事实，与 TUNEX_PUBLIC_PANEL_URL 同层）。
 * **没有**权限门：改面板地址意味着面板本身在迁移，能改这三个值的只有能动面板部署的人；
 * 若将来要做成 UI/API 入口，需要先加一个 `SystemConfigName` 枚举成员或新表（都要迁移）。
 */
export const PANEL_MIGRATION_ENV_KEYS = {
  fallbackUrl: "TUNEX_PANEL_MIGRATION_FALLBACK_URL",
  migrationId: "TUNEX_PANEL_MIGRATION_ID",
  startedAt: "TUNEX_PANEL_MIGRATION_STARTED_AT",
} as const;

/** 面板侧认可的迁移配置（已校验）。 */
export interface PanelMigrationConfig {
  /** 迁移标识（面板侧生成，用于审计与"同一迁移不重复处理"）。 */
  id: string;
  /** 备用面板地址（已去掉尾部斜杠）。 */
  fallbackUrl: string;
  /** 迁移起始时间（RFC3339）；`null` = 面板没声明 ⇒ Agent 侧只能用失败阈值判据。 */
  startedAt: string | null;
}

export type PanelMigrationParse =
  | { ok: true; migration: PanelMigrationConfig }
  /** 三键都空 = 未配置（正常缺省，不是故障）。 */
  | { ok: false; reason: "not_configured" }
  /** 只填了一部分 / 形状坏了 —— 必须被运维看见，不能当成"没配"。 */
  | { ok: false; reason: "incomplete" | "bad_url" | "bad_started_at" | "bad_shape"; detail: string }
  /**
   * **读不到配置**（DB 查询失败）—— 与"确实没配置"必须分开：前者是可重试的降级，
   * 后者是部署方的决定。把两者都渲染成"未配置"就是"取不到 ⇒ 显示成没事"那一类错误。
   */
  | { ok: false; reason: "unreadable"; detail: string };

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 校验面板侧的迁移配置。
 *
 * 输入可以是 `config` 表里那串 JSON（字符串），也可以是已经解析过的对象（便于调用方
 * 复用；测试两种都覆盖）。**空值/空对象 = 未配置**；只填一部分 = `incomplete`。
 */
/**
 * 解析三个**原始输入**（面板侧环境变量的值，或已解析的对象）。
 *
 * 规则与 Agent 侧 `agentconfig.Config.PanelMigration` 逐条对齐：
 * 三键全空 ⇒ `not_configured`（正常缺省）；只填一部分 ⇒ `incomplete`（必须被看见）；
 * 形状坏了 ⇒ `bad_url` / `bad_started_at` / `bad_shape`。
 */
export function parsePanelMigration(raw: unknown): PanelMigrationParse {
  if (typeof raw === "string") {
    const text = raw.trim();
    if (text === "") return { ok: false, reason: "not_configured" };
    // 兼容"整段 JSON"的输入（便于 ops 用一个变量携带全部三项）。
    try {
      const parsed = asRecord(JSON.parse(text));
      if (!parsed) return { ok: false, reason: "bad_shape", detail: "迁移配置必须是 JSON 对象" };
      return parsePanelMigration(parsed);
    } catch {
      return { ok: false, reason: "bad_shape", detail: "这串值既不是 JSON 对象也不是空值" };
    }
  }
  if (raw === null || raw === undefined) return { ok: false, reason: "not_configured" };
  const record = asRecord(raw);
  if (!record) return { ok: false, reason: "bad_shape", detail: "迁移配置必须是对象" };

  const id = trimmed(record.id ?? record.migration_id ?? record.migrationId);
  const fallbackRaw = trimmed(record.fallback_url ?? record.fallbackUrl);
  const startedRaw = trimmed(record.started_at ?? record.startedAt);

  if (id === "" && fallbackRaw === "" && startedRaw === "") return { ok: false, reason: "not_configured" };
  if (id === "" || fallbackRaw === "") {
    return {
      ok: false,
      reason: "incomplete",
      detail: `缺少 ${id === "" ? "id" : "fallback_url"}（两个键齐备才生效；只填一个不会启用回退）`,
    };
  }

  const fallbackUrl = fallbackRaw.replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/i.test(fallbackUrl)) {
    return { ok: false, reason: "bad_url", detail: `fallback_url 必须是绝对 http(s) 地址：${fallbackRaw}` };
  }

  let startedAt: string | null = null;
  if (startedRaw !== "") {
    if (!isAcceptableStartedAt(startedRaw)) {
      return {
        ok: false,
        reason: "bad_started_at",
        detail: `started_at 必须是 RFC3339 时间或 unix 秒：${startedRaw}`,
      };
    }
    startedAt = startedRaw;
  }

  return { ok: true, migration: { id, fallbackUrl, startedAt } };
}

/**
 * 从**部署环境变量**读这套配置（面板侧的唯一入口）。
 *
 * `read` 参数便于测试注入；缺省读 `process.env`。三个键的取值语义与
 * {@link parsePanelMigration} 一致（全空 = 未配置）。
 */
export function readPanelMigrationFromEnv(
  read: (key: string) => string | undefined = (key) => process.env[key],
): PanelMigrationParse {
  return parsePanelMigration({
    id: read(PANEL_MIGRATION_ENV_KEYS.migrationId),
    fallback_url: read(PANEL_MIGRATION_ENV_KEYS.fallbackUrl),
    started_at: read(PANEL_MIGRATION_ENV_KEYS.startedAt),
  });
}

/**
 * 渲染 `agent.env` 的环境行。**未配置 ⇒ 返回空数组**（一个键都不写）——
 * 与参照实现的"齐备才写、否则三个一起删"同一语义：不留下半个回退态。
 */
export function renderPanelMigrationEnv(migration: PanelMigrationConfig): string[] {
  return [
    `TUNEX_PANEL_FALLBACK_URL=${migration.fallbackUrl}`,
    `TUNEX_PANEL_MIGRATION_ID=${migration.id}`,
    ...(migration.startedAt === null ? [] : [`TUNEX_PANEL_MIGRATION_STARTED_AT=${migration.startedAt}`]),
  ];
}

/**
 * 起始时间的两种可接受形状：unix 秒（正整数）或 RFC3339（与 Agent 侧的 Go 解析一致）。
 * 这里刻意**不**接受 `new Date()` 能解析的其它形状（如 `2026/10/07`）——两侧口径必须
 * 逐字一致，否则面板写下去的值会被 Agent 拒绝。
 */
function isAcceptableStartedAt(value: string): boolean {
  if (/^[0-9]+$/.test(value)) return Number(value) > 0;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

/** 一次调用拿到的面板侧迁移投影（读投影用；`configured=false` 时其余字段为 null）。 */
export interface PanelMigrationView {
  /** 配置来源（写成常量，避免前端猜）：面板侧部署环境变量。 */
  source: string;
  configured: boolean;
  id: string | null;
  fallback_url: string | null;
  started_at: string | null;
  /** 配置坏了时的原因（`configured=false` 但 `problem!=null` ⇒ 运维必须处理）。 */
  problem: string | null;
  /** 面板侧**尚未**持久化 Agent 上报的"当前生效地址/是否回退态"（需要新列，见报告）。 */
  node_reported_state_persisted: false;
}

export function panelMigrationView(parsed: PanelMigrationParse): PanelMigrationView {
  if (parsed.ok) {
    return {
      source: `env:${PANEL_MIGRATION_ENV_KEYS.fallbackUrl}`,
      configured: true,
      id: parsed.migration.id,
      fallback_url: parsed.migration.fallbackUrl,
      started_at: parsed.migration.startedAt,
      problem: null,
      node_reported_state_persisted: false,
    };
  }
  return {
    source: `env:${PANEL_MIGRATION_ENV_KEYS.fallbackUrl}`,
    configured: false,
    id: null,
    fallback_url: null,
    started_at: null,
    // 只有"确实没配置"才是 problem=null；"读不到"必须是可见的问题（可重试的降级），
    // 否则运维会把一次 DB 抖动读成"这台面板没有迁移配置"。
    problem: parsed.reason === "not_configured" ? null : `${parsed.reason}: ${parsed.detail}`,
    node_reported_state_persisted: false,
  };
}
