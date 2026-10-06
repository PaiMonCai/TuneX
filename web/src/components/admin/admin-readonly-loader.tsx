import { cookies } from "next/headers";
import { api } from "@/lib/api";
import { AdminReadonlyManager, type ReadonlySegment } from "@/components/admin/admin-readonly-manager";
import { AdminResourceUnavailable, loadAdminResource } from "@/components/admin/admin-resource-state";
import type { Paginated } from "@/lib/types";

/**
 * 只读资源（tunnels / orders / tickets）的服务端取数壳：
 * 在服务端预取首屏，再交给客户端 `AdminReadonlyManager` 提供搜索/过滤/刷新。
 *
 * 与 `admin-resource-list.tsx` 同一纪律：这里以前也是 `catch → EMPTY`，
 * 于是 403 / 取不到 与「真的没有数据」在界面上完全一样。现在失败保留原因，
 * 渲染受控提示卡（含重试），空数组只可能来自**成功**的读取。
 */
export async function AdminReadonlyLoader({ segment }: { segment: ReadonlySegment }) {
  const cookie = (await cookies()).toString();
  const q = { page: 1, page_size: 20 };

  const load =
    segment === "tunnels"
      ? await loadAdminResource<Paginated<Record<string, unknown>>>(
          "转发列表",
          api.admin.tunnels(q, cookie) as unknown as Promise<Paginated<Record<string, unknown>>>,
        )
      : segment === "orders"
        ? await loadAdminResource<Paginated<Record<string, unknown>>>(
            "订单列表",
            api.admin.orders(q, cookie) as unknown as Promise<Paginated<Record<string, unknown>>>,
          )
        : await loadAdminResource<Paginated<Record<string, unknown>>>(
            "工单列表",
            api.admin.tickets(q, cookie) as unknown as Promise<Paginated<Record<string, unknown>>>,
          );

  if (!load.ok) return <AdminResourceUnavailable segment={segment} failure={load.failure} />;
  return <AdminReadonlyManager segment={segment} initialData={load.data} />;
}
