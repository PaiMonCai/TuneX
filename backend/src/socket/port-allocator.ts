/**
 * 动态端口分配器（多节点端口竞争修复）
 *
 * ⚠️ **LEGACY（WP3 起）—— 新代码请改用 `services/portPool.ts`。**
 *
 * 本文件是 v2「入口组内确定性端口分配」的既有实现，仍在 `config-generator.ts`
 * 的下发链路里服役（DIRECT 路径），**不要在新功能里引入它**。它与
 * `services/portPool.ts` 的关系与边界：
 *
 *   · **作用域不同**：本文件在**入口组**内分配（跨该组所有节点、所有 agent），
 *     依据是 `@@unique([listen_port, in_node_group_id])`；portPool 在
 *     **单个节点**上分配，依据是 `@@unique([node_id, port])`。两者不通用。
 *   · **持久化不同**：本文件纯函数、不落库不碰 Redis（配置生成幂等重算）；
 *     portPool 落 `node_port_lease` 行，DB 唯一约束是所有权终审。
 *   · **端口不会互相免让**：本文件分配的 DIRECT `listen_port` **没有**
 *     `node_port_lease` 行。因此任何调用 portPool 的地方，必须把同节点这些
 *     DIRECT 端口通过 `AcquirePortInput.reservedPorts` 灌进去，否则新分配的
 *     v3 端口会与 agent 正在 bind 的端口撞号——那种撞号**没有任何 DB 约束
 *     兜底**，比 v3 内部撞号危险得多。
 *
 * 迁移（WP8 编排器）：把 DIRECT 隧道逐步切到 `acquirePort` + `releaseLease`，
 * 由 portPool 统一所有权与对账；本文件随 DIRECT 存量清零后删除。
 *
 * ── 问题（见 reports/multi-node-verification.md §7 缺陷#5）──
 * 当隧道 `listen_port=NULL` 时，配置里下发 `WAIT_LISTEN<range>` 占位符，由**各
 * agent 进程内**自选端口（`engine/runtime.go#allocatePort`）。进程内 `usedPorts`
 * 无法跨 agent 协同：同一入口组的两个 agent 会各自选到同一个空闲端口，先后
 * `bind` 时后者 `EADDRINUSE`；同一 agent 内 TCP/UDP 还会撞同一端口号。
 *
 * ── 修复思路 ──
 * 控制面（backend）掌握「入口组 → 该组全部隧道」的**全集**，因此在生成配置时
 * **确定性地**为每个动态监听槽在该组 `port_range` 内分配一个**唯一**端口，并直接
 * 写进下发的 `addr`（而非 `WAIT_LISTEN` 占位符）。于是：
 *   · 同组所有 agent 拿到**同一份**端口映射 → 组内不冲突；
 *   · 同一隧道的 tcp / udp 是两个独立槽 → 不会同号；
 *   · 跨组依然允许同号（入口组天然隔离，符合
 *     `@@unique([listen_port, in_node_group_id])` 语义）。
 *
 * ── 纯函数 / 无持久化 ──
 * 分配只依赖 `(slots, port_range)`，**同一输入恒产出同一映射**，因此无需落库或
 * Redis：配置生成是幂等的，每次重算结果一致，agent 重连也拿到相同端口。显式固定
 * 的 `listen_port` 作为**保留端口**参与去重，保证「固定端口」与「自动分配端口」
 * 两个通道也不会互撞。
 *
 * ⚠️ 仅用于**入口（in）节点**配置：出口节点的监听端口是**按节点**上报的
 * （agent 选端口 → `listen` 事件 → `tunnel:out_listen` 缓存），若改成服务端固定
 * 端口，agent 不再上报，出口链路 hops 反而会变空（缺陷#2）。
 */

/** 端口段（含端点）。 */
export interface PortSegment {
  lo: number;
  hi: number;
}

/** 解析后的端口区间。 */
export interface PortRange {
  segments: PortSegment[];
}

/** 参与分配的最小隧道视图。 */
export interface AllocatableTunnel {
  id: number;
  listen_port: number | null;
}

/** 端口号合法范围。 */
const MIN_PORT = 1;
const MAX_PORT = 65535;
/** 展开段落的硬上限，防止 `1-65535` 级别的输入造成内存放大。 */
const MAX_EXPAND = 65536;

/**
 * 解析 `--port-range` 形态的端口区间串。
 * 语法与原版一致：逗号分隔的「单端口」或「起-止」闭区间，如 `80,443,30000-30010`。
 * 非法片段（非数字、lo>hi、越界）被忽略。
 */
export function parsePortRange(spec: string | null | undefined): PortRange {
  const segments: PortSegment[] = [];
  if (typeof spec !== "string") return { segments };
  for (const raw of spec.split(",")) {
    const part = raw.trim();
    if (part === "") continue;
    const dash = part.indexOf("-");
    if (dash >= 0) {
      const lo = Number(part.slice(0, dash).trim());
      const hi = Number(part.slice(dash + 1).trim());
      if (isValidPort(lo) && isValidPort(hi) && hi >= lo) segments.push({ lo, hi });
      continue;
    }
    const p = Number(part);
    if (isValidPort(p)) segments.push({ lo: p, hi: p });
  }
  return { segments };
}

/** 区间是否不含任何可用端口。 */
export function isEmptyRange(range: PortRange): boolean {
  return range.segments.length === 0;
}

/**
 * 把区间展开为**升序去重**的端口列表（受 {@link MAX_EXPAND} 限制）。
 * 分配按此顺序取端口，因此是确定性的。
 */
export function expandPorts(range: PortRange): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const seg of range.segments) {
    for (let p = seg.lo; p <= seg.hi && out.length < MAX_EXPAND; p++) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * 有状态的端口分配器：一个实例服务于**一个节点组**的**一次配置生成**。
 *
 * 用法：
 * ```ts
 * const alloc = new DynamicPortAllocator(tunnels.map(t => t.listen_port), group.port_range);
 * const addr = alloc.assign(`${tunnel.id}:tcp`) ?? waitListenAddr(listenIp, range);
 * ```
 * 同一 `slotKey` 重复调用返回同一端口（幂等），因此 tcp/udp 两个槽分别取
 * `${id}:tcp` / `${id}:udp` 即得互不相同的端口。
 */
export class DynamicPortAllocator {
  private readonly ports: number[];
  private readonly reserved = new Set<number>();
  private readonly assigned = new Map<string, number>();

  constructor(
    fixedPorts: Iterable<number | null | undefined>,
    spec: string | null | undefined,
  ) {
    // 先保留全部显式固定端口，动态分配不会复用。
    for (const p of fixedPorts) {
      if (isValidPort(p)) this.reserved.add(p);
    }
    this.ports = expandPorts(parsePortRange(spec));
  }

  /**
   * 为槽 `slotKey` 分配端口。
   * @param fixedPort 非空 → 直接采用该固定端口（并保留）。
   * @returns 端口号；`null` 表示区间耗尽（调用方回退到 `WAIT_LISTEN`）。
   */
  assign(slotKey: string, fixedPort?: number | null): number | null {
    const cached = this.assigned.get(slotKey);
    if (cached !== undefined) return cached;
    if (isValidPort(fixedPort)) {
      this.reserved.add(fixedPort);
      this.assigned.set(slotKey, fixedPort);
      return fixedPort;
    }
    for (const p of this.ports) {
      if (!this.reserved.has(p)) {
        this.reserved.add(p);
        this.assigned.set(slotKey, p);
        return p;
      }
    }
    return null;
  }

  /** 已分配（或固定）的端口数。 */
  get size(): number {
    return this.assigned.size;
  }
}

/**
 * 纯函数式封装（供单测 / 无状态使用）：按 slots 顺序分配，返回 `Map<key, port>`。
 * 显式固定端口同样先保留；区间耗尽后剩余槽不再返回。
 */
export function allocatePortsBySlot(
  slots: readonly { key: string; fixedPort?: number | null }[],
  spec: string | null | undefined,
): Map<string, number> {
  const alloc = new DynamicPortAllocator(slots.map((s) => s.fixedPort), spec);
  const out = new Map<string, number>();
  for (const s of slots) {
    const p = alloc.assign(s.key, s.fixedPort);
    if (p !== null) out.set(s.key, p);
  }
  return out;
}

/**
 * 便捷封装：为一批隧道的动态端口（`listen_port == null`）分配唯一端口，key = 隧道 id。
 * 仅适用于「一隧道一监听」的独立使用；配置生成需区分 tcp/udp 两个槽时请用
 * {@link DynamicPortAllocator}。
 */
export function allocateDynamicPorts(
  tunnels: readonly AllocatableTunnel[],
  spec: string | null | undefined,
): Map<number, number> {
  const ordered = [...tunnels].sort((a, b) => a.id - b.id);
  const byKey = allocatePortsBySlot(
    ordered.map((t) => ({ key: String(t.id), fixedPort: t.listen_port })),
    spec,
  );
  const out = new Map<number, number>();
  for (const t of ordered) {
    const p = byKey.get(String(t.id));
    if (p !== undefined) out.set(t.id, p);
  }
  return out;
}

/** 拼「<prefix>:<port>」监听地址（prefix 通常为 listen_ip，空则形如 `:8080`）。 */
export function formatListenAddr(prefix: string | null | undefined, port: number): string {
  return `${prefix ?? ""}:${port}`;
}

/** 参与动态端口解析的服务最小形状（保留其余字段）。 */
export interface DynamicServiceLike {
  name: string;
  addr: string;
}

/** 参与动态端口解析的隧道信息。 */
export interface TunnelPortInfo {
  id: number;
  listen_port: number | null;
  listen_ip?: string | null;
}

/**
 * 把入口配置里**动态端口**服务的 `addr` 从 `WAIT_LISTEN<range>` 占位符替换为
 * 控制面分配的**唯一固定端口**（多节点端口竞争修复的落地函数）。
 *
 * 原契约：所有 agent 各自在 range 内自选端口 → 组内多节点撞号。改为服务端分配后，
 * 同组 agent 拿到同一份映射，组内不可能冲突；同隧道的 tcp/udp 是两个独立槽，也
 * 不会同号。固定端口的服务（addr 不含占位符）原样保留，并作为保留端口参与去重。
 * 区间耗尽时该服务回退为原占位符（由 agent 自选，向后兼容、不丢服务）。
 *
 * @param services    待改写的服务数组（浅拷贝返回，不改动入参）
 * @param tunnels     入口组内全部隧道（提供固定端口、id↔listen_ip 映射）
 * @param portRange   入口节点组的端口区间
 * @param placeholder 动态端口占位符（默认 `WAIT_LISTEN`）
 */
export function resolveDynamicServicePorts<T extends DynamicServiceLike>(
  services: readonly T[],
  tunnels: readonly TunnelPortInfo[],
  portRange: string | null | undefined,
  placeholder = "WAIT_LISTEN",
): T[] {
  const alloc = new DynamicPortAllocator(
    tunnels.map((t) => t.listen_port),
    portRange,
  );
  const byId = new Map<number, TunnelPortInfo>();
  for (const t of tunnels) byId.set(t.id, t);
  const fixedPorts = new Set<number>();
  for (const t of tunnels) {
    if (t.listen_port !== null && t.listen_port !== undefined) fixedPorts.add(t.listen_port);
  }

  return services.map((svc) => {
    if (typeof svc.addr !== "string" || svc.addr.indexOf(placeholder) < 0) return svc;

    // `tcp-123` / `udp-123`：隧道监听槽（tcp/udp 是同一隧道的两个独立槽）。
    const m = /^(tcp|udp)-(\d+)$/.exec(svc.name);
    if (m) {
      const id = Number(m[2]);
      const t = byId.get(id);
      const fixed = t ? t.listen_port : null;
      const listenIp = t?.listen_ip ?? "";
      const port = alloc.assign(`${id}:${m[1]}`, fixed);
      if (port !== null) return { ...svc, addr: formatListenAddr(listenIp, port) };
      return svc;
    }

    // 额外动态槽（relay / chain 等）：仅当其端口不与任何隧道固定端口相撞时更新。
    const port = alloc.assign(`extra:${svc.name}`);
    if (port !== null && !fixedPorts.has(port)) return { ...svc, addr: formatListenAddr("", port) };
    return svc;
  });
}

function isValidPort(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= MIN_PORT && v <= MAX_PORT;
}
