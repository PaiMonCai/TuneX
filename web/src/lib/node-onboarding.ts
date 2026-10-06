/**
 * I1-B —— 用户端「添加节点」接入（onboarding）的**纯逻辑**（无 React / 无网络 / 无 IO）。
 *
 * 这里只回答四类问题，且都能在无浏览器环境下断言：
 *
 *   1. **投影**：用户域只有 `GET /api/nodes`（没有单节点读端点）。列表行 → 等待组件
 *      需要的最小视图（`connection` / `has_credential`），不发明新字段、不做在线判定
 *      （判定权在服务端 `deriveConnection` / `nodeAdmission`）。
 *   2. **事实新鲜度**：`POST /node-groups/:id/nodes`（provision）的响应是**窄响应**
 *      —— 只有 `id / node_id / agent_id / role / port_range / group`，
 *      没有 `connection` / `registered` / `has_credential` / 准入结论。因此：
 *        · 新建时先拿窄快照显示「等待安装」，**随后立即用当前工作空间的
 *          `GET /api/nodes` 覆盖**（唯一权威事实源）；
 *        · 列表取不到 ≠ 节点不存在，明确标成 `list_unavailable` 并可重试，
 *          绝不把「取不到」当「没有节点」。
 *   3. **护栏**：每个异步操作在开始处抓一份 `(workspace, epoch, ticket)`，响应回来
 *      后再比对现值。切 Workspace / 权限变更 / 被后继操作取代时丢弃——跨 Workspace
 *      展示敏感安装命令是安全边界，不是体验偏好。**catch / finally 同样要过这道闸**：
 *      旧作用域的错误 toast 与「解锁新请求的 busy」都是同一类越界。
 *   4. **下一步**：`connection` + `role` + `accepts_new_business` + `forward:create`
 *      共同决定「能不能创建第一条转发」，以及**不能时到底为什么**。缺事实时给
 *      「未知」，绝不把「没有证据」渲染成「已通过」。
 */
import type {
  ID,
  NodeConnectionValue,
  NodeEnrollmentIssued,
  NodeRole,
  ProvisionNodeResult,
  UserNode,
} from "./types";

/* ================================================================== */
/* 视图投影                                                            */
/* ================================================================== */

/**
 * 该视图里的连接/凭据事实是怎么来的。
 *
 *   `loaded`           —— 来自当前工作空间的用户节点列表（**唯一权威事实源**）；
 *   `provision`        —— 来自 provision 的**窄响应**（新建节点的瞬时快照）；
 *   `list_unavailable` —— 列表**取不到**：事实未知，既不能说「还在等安装」，
 *                         也不能说「节点不存在」，只能在界面上如实说明并可重试。
 */
export type UserOnboardingReadState = "loaded" | "provision" | "list_unavailable";

/**
 * 等待组件需要的最小视图（I1-A 契约：最少 `{connection, has_credential}`）。
 *
 * 额外字段都是**后端已有的安全投影**，只用来决定下一步文案；其中
 * `found` 表示该节点还在当前工作空间的列表里——列表是用户域唯一事实来源，
 * 找不到就直说，不拿旧快照冒充现值；`read` 说明这份事实来自哪里。
 */
export interface UserNodeOnboardingView {
  connection: NodeConnectionValue | null;
  has_credential: boolean | null;
  accepts_new_business: boolean | null;
  role: NodeRole | null;
  registered: boolean | null;
  /** `false` = 该节点已不在列表里（被删除或不属于当前工作空间）。 */
  found: boolean;
  /** 事实来源（见 {@link UserOnboardingReadState}）。旧调用方可能没带，缺省按 `loaded` 读。 */
  read: UserOnboardingReadState;
}

/** 空视图（没有任何事实）。`read` 取 `list_unavailable`，避免被当成「读到了空列表」。 */
export function emptyOnboardingView(read: UserOnboardingReadState = "list_unavailable"): UserNodeOnboardingView {
  return {
    connection: null,
    has_credential: null,
    accepts_new_business: null,
    role: null,
    registered: null,
    found: false,
    read,
  };
}

/**
 * 列表行 → 视图。
 *
 * 只搬运后端写的字段：`connection` / `has_credential` / `accepts_new_business` /
 * `role` / `registered` 缺失就是 `null`（未知），不用 `status` + `last_seen_at`
 * 现算一个（那就是第二套在线判据，与面板其它位置必然分叉）。
 */
export function userNodeOnboardingView(
  node: UserNode | null | undefined,
  read: UserOnboardingReadState = "loaded",
): UserNodeOnboardingView {
  // 列表读到了、但这一行不在里面 = 节点确实不在当前工作空间（`found:false`），
  // 不是「取不到」。`read` 保留调用方给的来源标记。
  if (!node) return emptyOnboardingView(read);
  return {
    connection: node.connection ?? null,
    has_credential: typeof node.has_credential === "boolean" ? node.has_credential : null,
    accepts_new_business: typeof node.accepts_new_business === "boolean" ? node.accepts_new_business : null,
    role: node.role ?? null,
    registered: typeof node.registered === "boolean" ? node.registered : null,
    found: true,
    read,
  };
}

/**
 * provision 的**窄响应** → 视图快照（新建节点的第一帧）。
 *
 * 必须诚实：provision 返回的 `node` 形状里没有 `connection` / `registered` /
 * `has_credential` / 准入结论，所以这里全部保持 `null`（未知），**不**
 * 用「刚创建所以一定在等待安装」去填一个假事实——那样一旦该 `node_id` 其实
 * 是复用已有节点（见 {@link duplicateNodeIdConflict}），界面会错误地把一台
 * 早已在线的机器显示成「等待安装」。
 *
 * `role` / `port_range` / 分组确实是后端写的事实，原样带上；`found: true` 表示
 * 「后端刚确认它存在」，`read: "provision"` 表示「这份连接事实待列表覆盖」。
 */
export function onboardingViewFromProvision(node: UserNode): UserNodeOnboardingView {
  return {
    connection: node.connection ?? null,
    has_credential: typeof node.has_credential === "boolean" ? node.has_credential : null,
    accepts_new_business:
      typeof node.accepts_new_business === "boolean" ? node.accepts_new_business : null,
    role: node.role ?? null,
    registered: typeof node.registered === "boolean" ? node.registered : null,
    found: true,
    read: "provision",
  };
}

/** 在用户域节点列表里找目标行（用户 API 没有 `GET /api/nodes/:id`，不新造端点）。 */
export function findUserNode(rows: readonly UserNode[], nodeId: ID): UserNode | null {
  const wanted = Number(nodeId);
  if (!Number.isFinite(wanted)) return null;
  return rows.find((row) => Number(row.id) === wanted) ?? null;
}

/** 列表快照 → 目标节点视图（找不到时 `found:false`，不抛给轮询）。 */
export function onboardingViewFromRows(rows: readonly UserNode[], nodeId: ID): UserNodeOnboardingView {
  return userNodeOnboardingView(findUserNode(rows, nodeId), "loaded");
}

/** 列表取不到时的视图：保留上次已知的节点标识类事实，但连接事实一律未知。 */
export function listUnavailableOnboardingView(previous?: UserNodeOnboardingView | null): UserNodeOnboardingView {
  return {
    ...emptyOnboardingView("list_unavailable"),
    // `found` 不沿用旧值：列表取不到时我们**不知道**它还在不在。
    found: previous?.found === true,
    role: previous?.role ?? null,
  };
}

/* ================================================================== */
/* 事实合并 / 新鲜度                                                    */
/* ================================================================== */

/**
 * 用权威列表视图覆盖本地快照（provision 窄响应）。
 *
 * 只接受 `read: "loaded"` 的来源：`list_unavailable` 的视图只说明「不知道」，
 * 拿它覆盖已确认的事实等于把事实降级。`loaded` 时逐字段以列表为准
 * （列表里缺某个字段就是 `null`，不沿用旧快照——旧快照可能是另一个作用域的）。
 */
export function mergeOnboardingViews(
  local: UserNodeOnboardingView,
  remote: UserNodeOnboardingView,
): UserNodeOnboardingView {
  if (remote.read !== "loaded") return local;
  return { ...remote };
}

/** 列表事实是否已就位（能据此判断节点存不存在、在线与否）。 */
export function hasAuthoritativeListFacts(view: UserNodeOnboardingView | null | undefined): boolean {
  return view?.read === "loaded";
}

/* ================================================================== */
/* 重复 node 标识（后端唯一键，前端提前拦截）                            */
/* ================================================================== */

/**
 * 输入名称是否与当前工作空间里已有节点同名。
 *
 * 后端 `POST /node-groups/:id/nodes` 对已存在的 `node_id` **不是**报错，而是
 * 「复用该节点并重签 enrollment」（`node.reprovisioned`）——会作废用户手上
 * 还没用的命令、并在消费时轮换长期凭据。因此创建前必须先在**当前作用域最新的
 * 用户列表**里查重，查到就拒绝并引导用户走既有的安装/重签入口，不盲目创建。
 *
 * 比较按**大小写不敏感**：数据库唯一键在默认排序规则（如 MySQL 的
 * `utf8mb4_general_ci` / Postgres 的 `citext` 部署）下就是大小写不敏感的，
 * 前端按同一口径比较，宁可多拦一次也不制造一个「点了没反应」的提交。
 */
export function duplicateNodeIdConflict(rows: readonly UserNode[], candidate: string): UserNode | null {
  const wanted = candidate.trim().toLowerCase();
  if (wanted === "") return null;
  return rows.find((row) => String(row.node_id ?? "").trim().toLowerCase() === wanted) ?? null;
}

/** 查重结论（`blocked` 时界面必须说明原因，不能只是禁用一个按钮）。 */
export type NodeIdDuplicateCheck =
  | { kind: "ok" }
  | { kind: "empty" }
  | { kind: "conflict"; nodeId: ID };

export function checkNodeIdDuplicate(rows: readonly UserNode[], candidate: string): NodeIdDuplicateCheck {
  if (candidate.trim() === "") return { kind: "empty" };
  const hit = duplicateNodeIdConflict(rows, candidate);
  return hit ? { kind: "conflict", nodeId: hit.id } : { kind: "ok" };
}

/* ================================================================== */
/* 作用域护栏                                                          */
/* ================================================================== */

/** 当前作用域：Workspace + 权限 epoch（epoch 只增不减，A→B→A 也会换刻度）。 */
export interface OnboardingScope {
  workspaceId: number | null;
  epoch: number;
}

/** 一次异步操作的坐标：作用域 + 同类操作的最新 ticket。 */
export interface OnboardingOperation extends OnboardingScope {
  ticket: number;
}

/** 作用域是否仍是开始时那一个（Workspace 与 epoch 都要相同）。 */
export function scopeIsCurrent(start: OnboardingScope, current: OnboardingScope): boolean {
  return start.workspaceId === current.workspaceId && start.epoch === current.epoch;
}

/**
 * 响应是否已经过期。
 *
 * `current.scope` 取**现值的快照**，`current.ticketCurrent` 由调用方的单调
 * fence（`createPermissionRequestFence()`）提供：同一 Workspace 内被后继操作
 * 取代的旧响应同样必须丢弃（否则「先建 A 再建 B」的晚到响应会把 B 顶掉）。
 *
 * **成功 / 失败 / finally 三条路径都要用它**：晚到的成功会显示旧作用域的命令，
 * 晚到的失败会弹一个已经无关的 toast，晚到的 finally 会解锁属于新请求的
 * `busy`（用户于是在第一个请求还在飞的时候又点了一次）。
 */
export function operationIsStale(
  start: OnboardingOperation,
  current: { scope: OnboardingScope; ticketCurrent: (ticket: number) => boolean },
): boolean {
  return !scopeIsCurrent(start, current.scope) || !current.ticketCurrent(start.ticket);
}

/**
 * 等待组件的 React `key`。
 *
 * 把 Workspace / 权限 epoch / 节点一起编进 key：作用域一变就**重建**等待状态，
 * 内部持有的安装命令与等待计时随组件一起被丢弃——这是「切 Workspace 不残留
 * 敏感命令」在渲染层的兜底（另一层是父组件显式清空状态）。
 */
export function onboardingScopeKey(workspaceId: number | null, epoch: number, nodeId: ID): string {
  return `${workspaceId ?? "none"}:${epoch}:${nodeId}`;
}

/* ================================================================== */
/* 用户域适配器                                                        */
/* ================================================================== */

/** 晚到响应被丢弃时抛出；调用方（等待组件）已有静默/提示路径。 */
export class StaleOnboardingResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleOnboardingResponseError";
  }
}

export interface UserOnboardingAdapterDeps {
  /** 用户域唯一数据源：`() => api.nodes.list()`。 */
  listNodes: () => Promise<UserNode[]>;
  /** 用户域签发入口：`(id) => api.nodes.enrollment(id)`；**不**走 admin API。 */
  issueEnrollment: (nodeId: ID) => Promise<NodeEnrollmentIssued>;
  /** 取现值作用域（父组件用 `getActiveWorkspace()` + epoch ref 提供）。 */
  scope: () => OnboardingScope;
  /** 丢弃晚到响应时的用户可读说明。 */
  staleMessage: string;
}

/**
 * 构造注入给共享等待组件的两个适配器。
 *
 * 两者都在 **await 前后各取一次作用域快照**：中间发生 Workspace / 权限切换时
 * 抛 {@link StaleOnboardingResponseError}，而不是把旧作用域的命令交给新作用域
 * 渲染。`issueEnrollment` 的返回值**原样返回**（不再补一次 POST 重签——重签会
 * 作废用户手上刚拿到的命令）。
 *
 * `loadView` 取不到列表时**不抛**：抛会让共享轮询把它当普通错误，而用户需要
 * 的是「这份事实暂时取不到」这个可渲染结论（`read: "list_unavailable"`）。
 * 作用域变化仍然抛（那不是「取不到」，是「不属于这里」）。
 */
export function createUserOnboardingAdapters(deps: UserOnboardingAdapterDeps): {
  loadView: (nodeId: ID) => Promise<UserNodeOnboardingView>;
  createEnrollment: (nodeId: ID) => Promise<NodeEnrollmentIssued>;
} {
  return {
    loadView: async (nodeId: ID) => {
      const started = deps.scope();
      let rows: UserNode[];
      try {
        rows = await deps.listNodes();
      } catch {
        if (!scopeIsCurrent(started, deps.scope())) {
          throw new StaleOnboardingResponseError(deps.staleMessage);
        }
        // 列表取不到 ≠ 节点不存在：如实降级，让界面给「重试」而不是「节点没了」。
        // 具体错误信息不在这里呈现——界面只该说「暂时取不到」，不该把 500 的
        // 内部文案甩给用户；失败详情由页面的列表错误块统一承担。
        return listUnavailableOnboardingView(null);
      }
      if (!scopeIsCurrent(started, deps.scope())) {
        throw new StaleOnboardingResponseError(deps.staleMessage);
      }
      return onboardingViewFromRows(rows, nodeId);
    },
    createEnrollment: async (nodeId: ID) => {
      const started = deps.scope();
      const issued = await deps.issueEnrollment(nodeId);
      if (!scopeIsCurrent(started, deps.scope())) {
        throw new StaleOnboardingResponseError(deps.staleMessage);
      }
      return issued;
    },
  };
}

/* ================================================================== */
/* 新建目标                                                            */
/* ================================================================== */

export interface NodeOnboardingTarget {
  node: UserNode;
  enrollment: NodeEnrollmentIssued;
  /** provision 窄响应 → 待列表覆盖的初始视图（{@link onboardingViewFromProvision}）。 */
  initialView: UserNodeOnboardingView;
}

/**
 * 新建路径：`provisionNode` 已经签发了 enrollment，**直接保留**。
 *
 * 这条 return 是「不要每次点一键安装都重签」的关键接缝：创建成功后若为了
 * 「再拿一份命令」补一次 `POST /enrollment`，后端会撤销刚签发的那个令牌——
 * 用户复制到一半的命令当场失效。
 */
export function nodeOnboardingTargetFromProvision(created: ProvisionNodeResult): NodeOnboardingTarget {
  return {
    node: created.node,
    enrollment: created.enrollment,
    initialView: onboardingViewFromProvision(created.node),
  };
}

/* ================================================================== */
/* 自动等待（production 窄响应下也要能等）                              */
/* ================================================================== */

/**
 * 是否应当自动开始/继续等待（用户域决策，父组件传给共享等待组件）。
 *
 * ── 为什么需要它 ──
 * 共享等待组件自带的自动开始只看「`phase === "awaiting_install"`」，而 production
 * provision 的窄响应里 `connection` 是 **undefined** → `installPhase` = `unknown`
 * → 自动等待永远不会开始，用户就回到了「复制完命令没有下文」。
 *
 * ── 判据 ──
 *   1. 必须**手里有一条已签发的 enrollment**（没命令可给，等待没有意义）；
 *   2. `unknown` **继续等**：未知不是「装好了」，也不是「不在等」；轮询正是把
 *      unknown 变成已知的唯一手段（共享组件的 A2 防线做同一件事）；
 *   3. `awaiting_install` 继续等；
 *   4. `online` / `installed_offline` 停：闭环已达成，或已确认装过（掉线是连接
 *      问题，不该继续显示「等待安装」）。
 */
export function shouldKeepWaiting(input: {
  hasEnrollment: boolean;
  phase: OnboardingViewPhase;
}): boolean {
  if (!input.hasEnrollment) return false;
  if (input.phase === "online" || input.phase === "installed_offline") return false;
  return true;
}

/** {@link shouldKeepWaiting} 消费的最小阶段集合（与 `lib/node-lifecycle` 的 `InstallPhase` 同形）。 */
export type OnboardingViewPhase = "awaiting_install" | "online" | "installed_offline" | "unknown";

/* ================================================================== */
/* 节点组前置条件                                                      */
/* ================================================================== */

export type NodeGroupState = "loading" | "ready" | "empty" | "error";

export interface NodeGroupFacts {
  canManage: boolean;
  loading: boolean;
  failed: boolean;
  count: number;
}

/**
 * 节点组加载状态 → 界面状态。
 *
 * 没有 `node:manage` 的用户根本没有创建入口，不拿「节点组」这个前置条件去
 * 打扰他（否则只读用户会以为自己漏配了什么）。
 */
export function nodeGroupState(facts: NodeGroupFacts): NodeGroupState {
  if (!facts.canManage) return "ready";
  if (facts.loading) return "loading";
  if (facts.failed) return "error";
  return facts.count > 0 ? "ready" : "empty";
}

/** 空态 / 前置条件的 persona：能不能管理，决定说的是「去创建」还是「权限」真话。 */
export function nodeGroupPrerequisitePersona(input: {
  canManage: boolean;
  canRead: boolean;
}): "manager" | "readonly" | "denied" {
  if (input.canManage) return "manager";
  return input.canRead ? "readonly" : "denied";
}

/**
 * 创建是否可提交（按钮 `disabled` 的唯一依据，防无效提交）。
 *
 * 三种「不能提交」必须分开，因为下一步动作完全不同：
 *   · 没有组 / 组还没加载出来        → 先解决组（失败可重试）；
 *   · 列表还没读到（`listRead === false`）→ 无法在前端查重，**不盲目创建**
 *     （同名 `node_id` 会被后端当成「复用并重签」，风险已在确认区写明，
 *     但能提前拦的就该提前拦）；
 *   · 与当前工作空间已有节点同名      → 直接拒绝，引导走既有安装/重签入口。
 */
export function canSubmitNodeCreation(input: {
  canManage: boolean;
  groupState: NodeGroupState;
  nodeId: string;
  groupId: string;
  /** 是否已拿到当前作用域的节点列表（查重前提）。 */
  listRead?: boolean;
  /** 是否与已有节点同名（大小写不敏感）。 */
  duplicate?: boolean;
}): boolean {
  if (!input.canManage || input.groupState !== "ready") return false;
  if (input.nodeId.trim() === "") return false;
  const groupId = Number(input.groupId);
  if (!Number.isInteger(groupId) || groupId <= 0) return false;
  if (input.duplicate === true) return false;
  if (input.listRead === false) return false;
  return true;
}

/** 提交按钮被禁用时必须**就地说清**是哪一个前置条件，而不是让用户猜。 */
export function nodeCreationBlockedReasonKey(input: {
  canManage: boolean;
  groupState: NodeGroupState;
  nodeId: string;
  groupId: string;
  listRead?: boolean;
  duplicate?: boolean;
}): string | null {
  if (canSubmitNodeCreation(input)) return null;
  if (!input.canManage) return "node.createBlockedPermission";
  if (input.groupState === "loading") return "node.createBlockedGroupsLoading";
  if (input.groupState === "error") return "node.createBlockedGroupsFailed";
  if (input.groupState === "empty") return "node.createBlockedGroupsEmpty";
  if (input.nodeId.trim() === "") return "node.createBlockedNodeId";
  if (input.duplicate === true) return "node.createBlockedDuplicate";
  if (input.listRead === false) return "node.createBlockedListUnavailable";
  return "node.createBlockedGroupId";
}

/* ================================================================== */
/* 节点列表加载状态（失败不是「0 个节点」）                              */
/* ================================================================== */

/**
 * 节点列表的界面状态。
 *
 * 关键区分：`failed` **不是** `empty`。把一次失败的请求渲染成「还没有节点，
 * 去创建吧」会同时骗两件事——用户的机器可能好好地在线，而他会照着空态去重复
 * 装一台。
 */
export type NodeListState = "loading" | "ready" | "empty" | "failed" | "denied";

export function nodeListState(input: {
  canRead: boolean;
  loading: boolean;
  failed: boolean;
  count: number;
}): NodeListState {
  if (!input.canRead) return "denied";
  if (input.failed) return "failed";
  if (input.loading) return "loading";
  return input.count > 0 ? "ready" : "empty";
}

/**
 * 只读用户（无 `node:manage`）点击创建入口时的就地说明。
 *
 * 按钮 `disabled` 旁边必须有原因：只写一句「禁用」会让用户反复点，而原因
 * （权限）恰好是他唯一能去解决的。
 */
export function nodeCreateDisabledReasonKey(input: {
  canManage: boolean;
  groupState: NodeGroupState;
}): string | null {
  if (!input.canManage) return "node.createBlockedPermission";
  if (input.groupState === "loading") return "node.createBlockedGroupsLoading";
  if (input.groupState === "error") return "node.createBlockedGroupsFailed";
  if (input.groupState === "empty") return "node.createBlockedGroupsEmpty";
  return null;
}

/* ================================================================== */
/* 显式重签的确认文案                                                  */
/* ================================================================== */

export const REINSTALL_CONFIRM_KEYS = {
  /** 尚未注册：只作废旧命令（不涉及长期凭据）。 */
  new: "node.reinstallConfirmNew",
  /** 已注册：旧命令作废 + 消费时替换长期凭据（旧 Agent 会掉线）。 */
  registered: "node.reinstallConfirmRegistered",
  /** 事实未知：**按更严格的一档**说（未知不能当作「没有凭据」）。 */
  unknown: "node.reinstallConfirmUnknown",
} as const;

export type ReinstallConfirmKind = keyof typeof REINSTALL_CONFIRM_KEYS;

/**
 * 重签确认文案的选择：已注册节点必须说清长期凭据会被替换。
 *
 * `registered === true` → `registered`；明确 `false` → `new`；
 * **未知（null / undefined / 空视图）→ `unknown`**，措辞与 registered 同为
 * 「可能替换长期凭据」的严格一档。绝不把「不知道」渲染成「没有凭据」。
 */
export function reinstallConfirmKind(
  node: Pick<UserNode, "registered"> | null | undefined,
): ReinstallConfirmKind {
  if (node?.registered === true) return "registered";
  if (node?.registered === false) return "new";
  return "unknown";
}

/** 视图版本的重签确认选择（面板持有的是 {@link UserNodeOnboardingView}）。 */
export function reinstallConfirmKindForView(
  view: Pick<UserNodeOnboardingView, "registered"> | null | undefined,
): ReinstallConfirmKind {
  if (view?.registered === true) return "registered";
  if (view?.registered === false) return "new";
  return "unknown";
}

export function reinstallConfirmKey(
  node: Pick<UserNode, "registered"> | null | undefined,
): string {
  return REINSTALL_CONFIRM_KEYS[reinstallConfirmKind(node)];
}

export function reinstallConfirmMessage(
  t: (key: string) => string,
  node: Pick<UserNode, "registered"> | null | undefined,
): string {
  return t(reinstallConfirmKey(node));
}

/** 由**当前最新视图**（不是创建时的快照）决定的重签确认文案。 */
export function reinstallConfirmMessageForView(
  t: (key: string) => string,
  view: Pick<UserNodeOnboardingView, "registered"> | null | undefined,
): string {
  return t(REINSTALL_CONFIRM_KEYS[reinstallConfirmKindForView(view)]);
}

/* ================================================================== */
/* 成功下一步（CTA）                                                   */
/* ================================================================== */

/**
 * 不能直接创建第一条转发时的原因。
 *
 * 每一个原因都必须对应**准确**的说明：把 egress 说成权限问题、把「没有准入
 * 结论」说成「被拒绝」，都会让用户去改一个没错的地方。
 */
export type ForwardCtaBlockedReason =
  | "egress"
  | "undeclared_role"
  | "permission"
  | "awaiting_install"
  | "not_connected_offline"
  | "unknown_connection"
  | "not_accepting"
  | "unknown_admission"
  | "list_unavailable";

export type ForwardCtaDecision = { kind: "cta" } | { kind: "blocked"; reason: ForwardCtaBlockedReason };

/** 原因 → 词条键（一一对应；测试会校验两本字典都有非空文案）。 */
export const FORWARD_CTA_BLOCKED_KEYS: Record<ForwardCtaBlockedReason, string> = {
  egress: "node.ctaBlockedEgress",
  undeclared_role: "node.ctaBlockedUndeclaredRole",
  permission: "node.ctaBlockedPermission",
  awaiting_install: "node.ctaBlockedAwaitingInstall",
  not_connected_offline: "node.ctaBlockedOffline",
  unknown_connection: "node.ctaBlockedUnknownConnection",
  not_accepting: "node.ctaBlockedNotAccepting",
  unknown_admission: "node.ctaBlockedUnknownAdmission",
  list_unavailable: "node.ctaBlockedListUnavailable",
};

export const FORWARD_CTA_BLOCKED_REASONS = Object.keys(FORWARD_CTA_BLOCKED_KEYS) as ForwardCtaBlockedReason[];

export function forwardCtaBlockedKey(reason: ForwardCtaBlockedReason): string {
  return FORWARD_CTA_BLOCKED_KEYS[reason];
}

/**
 * 「下一步」的完整结论（含「节点已不在列表」与「事实取不到」两种前置情况）。
 *
 * 成功 CTA 与「为什么不能」共用一次判定，避免两处各判一遍、各说一套。
 */
export type OnboardingNextStep =
  | { kind: "missing" }
  | { kind: "cta" }
  | { kind: "blocked"; reason: ForwardCtaBlockedReason };

export function onboardingNextStep(
  view: UserNodeOnboardingView | null,
  canCreateForward: boolean,
): OnboardingNextStep {
  // 列表本来就取不到：既不能确认在线，也不能断言节点没了。这是**可重试的降级**，
  // 与 `found:false`（权威列表里确实没有这一行）不同，文案也必须不同。
  if (view && view.read === "list_unavailable" && view.connection === null) {
    return { kind: "blocked", reason: "list_unavailable" };
  }
  // 列表是用户域唯一事实来源：找不到就直说，不拿旧快照（可能是另一个
  // Workspace 的行）继续渲染「在线」与 CTA。
  if (view && view.found === false) return { kind: "missing" };
  if (!view) return { kind: "blocked", reason: "unknown_connection" };
  return forwardCtaDecision({
    role: view.role,
    connection: view.connection,
    acceptsNewBusiness: view.accepts_new_business,
    canCreateForward,
  });
}

/**
 * 成功 CTA 判定。
 *
 * CTA 只在**四条同时成立**时可用（与批准方案一致）：
 *   role ∈ {ingress, both} ∧ connection === "online" ∧
 *   accepts_new_business === true ∧ forward:create。
 *
 * 其余情况返回原因，由界面给出准确说明——不指向一个必然 403/409 的入口。
 * `accepts_new_business` 缺失（旧后端 / 未投影）算「未知」而不是「拒绝」：
 * 两者对用户的下一步不同（前者刷新再看，后者去处理生命周期）。
 */
export function forwardCtaDecision(input: {
  role?: NodeRole | null;
  connection?: NodeConnectionValue | null;
  acceptsNewBusiness?: boolean | null;
  canCreateForward: boolean;
}): ForwardCtaDecision {
  const role = input.role ?? null;
  if (role === "egress") return { kind: "blocked", reason: "egress" };
  if (role !== "ingress" && role !== "both") return { kind: "blocked", reason: "undeclared_role" };

  // 权限在连接/准入之前：没有 forward:create 的用户，就算节点一切正常也建不了。
  if (!input.canCreateForward) return { kind: "blocked", reason: "permission" };

  if (input.connection === "online") {
    if (input.acceptsNewBusiness === true) return { kind: "cta" };
    if (input.acceptsNewBusiness === false) return { kind: "blocked", reason: "not_accepting" };
    return { kind: "blocked", reason: "unknown_admission" };
  }
  if (input.connection === "waiting") return { kind: "blocked", reason: "awaiting_install" };
  if (input.connection === "offline") return { kind: "blocked", reason: "not_connected_offline" };
  return { kind: "blocked", reason: "unknown_connection" };
}
