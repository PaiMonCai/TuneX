import { Suspense } from "react";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { NodeDetailManager } from "@/components/admin/node-detail-manager";
import { serverT } from "@/lib/server-i18n";
import { nodeDetailServer } from "@/lib/node-detail-server";
import { loadNodeState } from "@/lib/node-runtime-loader";

/**
 * 节点详情页（WP12）：/admin/nodes/[id]
 *
 * 第一段路由是 /admin/nodes，第二段是数字 id；[segment] 动态路由只吞「单段」路径，
 * 因此 /admin/nodes/1 不会与 /admin/[segment] 冲突（Next 16 已验证两者可共存，
 * 具体且真实的子路径优先匹配）。
 *
 * 服务端按 id 预取 NodeDetail（节点 + 凭据元数据 + 出口池 + 最近状态上报），
 * 客户端负责轮换/吊销/改角色等写操作。取数失败时给出「返回列表」的空态，
 * 而不是把错误抛给 ErrorBoundary。
 *
 * 运行态**单独**取（`loadNodeState` → `/api/admin/node/:id/state`），不复用聚合里的
 * `state`：那个字段分不出「取不到」与「没有上报」，而面板必须把两者显示成不同的事实。
 * loader 不会抛错，失败会带着原因回落成 `unavailable`（界面给可重试入口）。
 */
export default async function AdminNodeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { t } = await serverT();
  const nodeId = Number(id);
  if (!Number.isInteger(nodeId) || nodeId <= 0) notFound();

  let detail: Awaited<ReturnType<typeof nodeDetailServer>> | null = null;
  try {
    detail = await nodeDetailServer(nodeId);
  } catch {
    return (
      <AppShell title={t("admin.nodeDetailTitle")} subtitle={t("admin.management")} adminMode>
        <div className="flex flex-col items-center gap-3 py-20 text-center text-sm text-[var(--muted-foreground)]">
          <p>{t("common.loadFailed")}</p>
          <Link href="/admin/nodes" className="text-[var(--primary)] underline">
            {t("admin.nodes")}
          </Link>
        </div>
      </AppShell>
    );
  }
  if (!detail) notFound();

  // 运行态读数与聚合详情分开取：mock 模式下 api 客户端内部走 mocks（服务端与客户端
  // 取数口径一致），真实模式下走后端的单数路由 /api/admin/node/:id/state。
  const runtime = await loadNodeState(nodeId, (await cookies()).toString());

  return (
    <AppShell
      title={`${t("admin.nodeDetailTitle")} · ${detail.node_id}`}
      subtitle={t("admin.management")}
      adminMode
    >
      <Suspense fallback={<div className="h-96 animate-pulse rounded-lg bg-[var(--muted)]" />}>
        <NodeDetailManager nodeId={nodeId} initial={detail} runtime={runtime} />
      </Suspense>
    </AppShell>
  );
}
