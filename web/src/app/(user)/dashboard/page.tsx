import { AppShell } from "@/components/app-shell";
import { Suspense } from "react";
import { DashboardBody } from "@/components/dashboard/dashboard-body";

export default function DashboardPage() {
  return (
    <AppShell titleKey="dashboard.title" subtitleKey="dashboard.subtitle">
      <Suspense fallback={<div className="h-96 animate-pulse rounded-lg bg-[var(--muted)]" />}>
        <DashboardBody />
      </Suspense>
    </AppShell>
  );
}
