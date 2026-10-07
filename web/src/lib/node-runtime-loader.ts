/**
 * 运行态 loader：**服务端取数 → 客户端面板** 的那一步。
 *
 * ── 为什么不在 `node-runtime-panel.tsx` 里 ──
 * `node-runtime-panel.tsx` 顶部是 `"use client"`，它导出的每个值都是 client
 * reference；从服务端组件里**调用**这样的函数会在运行期抛
 * 「Attempted to call loadNodeState() from the server but loadNodeState is on the
 * client」（RSC 不允许调用客户端函数，只能作为组件渲染或作为 props 传下去，
 * 见 `node_modules/next/dist/docs/01-app/02-guides/server-and-client-boundary.md`）。
 * 原实现把 `loadNodeState` 放在那个文件里并注明「供服务端 loader 使用」，
 * 这是一条**走不通**的路。取数逻辑放在没有 `"use client"` 的模块里，
 * 服务端页面与测试都可以直接调用（本模块不 import `next/headers`，cookie 由调用方给）。
 *
 * ── 三条纪律 ──
 *   1. 失败**抛不出**去，但也不会被吞成 `null`：一律回落成 `unavailable`
 *      （带原因与后端 message），由界面表达成「取不到」；
 *   2. `200 + reported_at 为空` 才是「该节点还没有上报过」；
 *   3. 不在这里做任何正向推断（无 healthy/online 结论）。
 */
import { api } from "./api";
import { nodeRuntimeStateFromPayload, type NodeRuntimeState } from "./node-runtime-state";

export async function loadNodeState(nodeId: number, cookie: string): Promise<NodeRuntimeState> {
  try {
    return nodeRuntimeStateFromPayload(await api.admin.nodeState(nodeId, cookie));
  } catch (e) {
    return {
      status: "unavailable",
      reason: "request_failed",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
