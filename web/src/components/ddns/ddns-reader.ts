/**
 * DDNS 取数：**单调请求栅栏 + 三态**（loading / ready / unavailable）。
 *
 * ── 为什么单独一个模块 ──
 * ① 组件是 `"use client"`，其导出在服务端不可调用（见 `node-runtime-loader.ts` 的注释）；
 * ② "切 Workspace 丢弃晚到响应"是本切片的硬验收项，必须有**可确定复现**的行为测试，
 *    而不是靠"看代码觉得有栅栏"。这里把栅栏做成框架无关的小状态机，组件与测试用同一份。
 *
 * ── 三条纪律 ──
 *   1. 失败**不**回落成"没有"：一律 `unavailable`（带原因），由界面说"取不到"；
 *   2. 每个请求带自己的 `workspaceId`，且结果只在该请求仍是**最新**请求时才生效；
 *   3. 丢掉的晚到响应**不改状态**、也不抛错（抛出去只会变成一句假的失败提示）。
 */
import { apiMessageOf } from "@/lib/types/ddns";
import { createPermissionRequestFence } from "@/lib/workspace-permissions";

export type DdnsReadState<T> =
  | { status: "loading" }
  | { status: "ready"; workspaceId: number; value: T }
  | { status: "unavailable"; workspaceId: number; message: string };

export interface DdnsReadOutcome<T> {
  /** false = 这条响应已作废（切了 Workspace 或有更新的请求），**没有**写进状态。 */
  applied: boolean;
  state: DdnsReadState<T>;
}

export interface DdnsReader<T> {
  peek: () => DdnsReadState<T>;
  /** 切 Workspace / 重新加载前调用：作废所有在途请求，并回到 `loading`。 */
  reset: () => void;
  load: (workspaceId: number) => Promise<DdnsReadOutcome<T>>;
}

export function createDdnsReader<T>(fetchValue: (workspaceId: number) => Promise<T>): DdnsReader<T> {
  const fence = createPermissionRequestFence();
  let current: DdnsReadState<T> = { status: "loading" };
  return {
    peek: () => current,
    reset() {
      fence.next();
      current = { status: "loading" };
    },
    async load(workspaceId: number) {
      const ticket = fence.next();
      current = { status: "loading" };
      try {
        const value = await fetchValue(workspaceId);
        if (!fence.current(ticket)) return { applied: false, state: current };
        current = { status: "ready", workspaceId, value };
        return { applied: true, state: current };
      } catch (error) {
        if (!fence.current(ticket)) return { applied: false, state: current };
        current = {
          status: "unavailable",
          workspaceId,
          message: apiMessageOf(error) ?? (error instanceof Error ? error.message : String(error)),
        };
        return { applied: true, state: current };
      }
    },
  };
}
