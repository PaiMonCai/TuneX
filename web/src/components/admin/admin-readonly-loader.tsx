import { cookies } from "next/headers";
import { api } from "@/lib/api";
import { AdminReadonlyManager, type ReadonlySegment } from "@/components/admin/admin-readonly-manager";
import type { Paginated } from "@/lib/types";

const EMPTY: Paginated<Record<string, unknown>> = { data: [], total: 0, page: 1, page_size: 20 };

/**
 * 只读资源（tunnels / orders / tickets）的服务端取数壳：
 * 在服务端预取首屏，再交给客户端 `AdminReadonlyManager` 提供搜索/过滤/刷新。
 */
export async function AdminReadonlyLoader({ segment }: { segment: ReadonlySegment }) {
  const cookie = (await cookies()).toString();
  const q = { page: 1, page_size: 20 };

  let initial: Paginated<Record<string, unknown>>;
  try {
    if (segment === "tunnels") initial = (await api.admin.tunnels(q, cookie)) as unknown as Paginated<Record<string, unknown>>;
    else if (segment === "orders")
      initial = (await api.admin.orders(q, cookie)) as unknown as Paginated<Record<string, unknown>>;
    else initial = (await api.admin.tickets(q, cookie)) as unknown as Paginated<Record<string, unknown>>;
  } catch {
    initial = EMPTY;
  }

  return <AdminReadonlyManager segment={segment} initialData={initial} />;
}
