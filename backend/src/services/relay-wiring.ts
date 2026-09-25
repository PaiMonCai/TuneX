/**
 * WP11 — RELAY 编排器接线（进程级单例）。
 * `DEVELOPMENT.md` §7.13「所有运行操作统一走 orchestrator」。
 *
 * ── 为什么单独一个模块 ──
 * §7.13 要求 orchestrator 是**进程级共享**的：WP6 的 revision 闸门
 * （`ControlValidator`）挂在 validator 上，而闸门必须跨请求生效——
 * 每次请求 new 一个 Orchestrator 等于每次请求都放行一次 stale revision。
 * 所以这里做惰性构造 + 缓存，而不是让每个 route handler 自己 new。
 *
 * ── 凭据（一个已知的过渡态，如实记录）──
 * WP7 的 per-node credential 走「sha256 哈希 + revoked 位」的认证接口
 * （`services/node-credential.ts` 的 `decideNodeAuth`），而
 * `HttpAgentTransport.tokenForNode` 要求**同步**返回明文 bearer——
 * 两者方向相反（一个验哈希、一个发明文），所以暂时无法直接接通。
 * 当前接线用部署环境变量 `AGENT_ADMIN_TOKEN`（值只来自环境，本文件
 * 不含、不打印、不返回任何凭据）；per-node 明文凭据下发需要 WP7 补一个
 * 「进程级凭据缓存 + 连接时预热」的机制（`NodeSessionRegistry`），
 * 该机制落地后只需把 `tokenForNode` 换成查表，本模块其余部分不变。
 */
import { HttpAgentTransport, Orchestrator, type OrchestratorNode } from "./orchestrator.ts";

/** 惰性单例。`null` = 未接线。 */
let singleton: Orchestrator | null = null;
/** 接线失败原因（取一次，不再反复试——进程级故障不靠重试治）。 */
let wiringError: string | null = null;

/**
 * 每节点 bearer token。
 *
 * **过渡态**：见文件头「凭据」段。当前按部署维度取一把共享管理面 token
 * （agent 侧 `withAuth` 只校验非空 bearer，因此单 token 即可跑通闭环；
 * per-node 凭据落地前，节点侧的最终鉴权仍由 WP7 的认证路径兜底）。
 */
function tokenForNode(_node: OrchestratorNode): string | null {
  return process.env.AGENT_ADMIN_TOKEN ?? null;
}

/**
 * 取得进程级编排器。
 *
 * 失败**不抛出**：未接线时返回 null，让上层把隧道停在 pending
 * （`tunnel-api.ts` 有显式的「未接线不假装成功」分支），而不是 500 掉整个
 * 创建请求——期望状态已经落库，晚点由 reconciler 补发（§7.12）比回滚
 * 体验更好。
 */
export function getOrchestrator(): Orchestrator | null {
  if (singleton) return singleton;
  if (wiringError) return null;
  try {
    const transport = new HttpAgentTransport({
      ...(process.env.AGENT_ADMIN_PORT ? { port: Number(process.env.AGENT_ADMIN_PORT) } : {}),
      tokenForNode,
    });
    singleton = new Orchestrator({ transport });
    return singleton;
  } catch (e) {
    wiringError = e instanceof Error ? e.message : String(e);
    return null;
  }
}

/** 替换单例（测试注入替身编排器；不改进程其余部分）。 */
export function setOrchestrator(o: Orchestrator | null): void {
  singleton = o;
}

/** 测试/热重载后重置（避免跨用例串味）。 */
export function resetOrchestrator(): void {
  singleton = null;
  wiringError = null;
}
