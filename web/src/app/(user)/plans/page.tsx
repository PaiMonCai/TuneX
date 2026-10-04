import { AppShell } from "@/components/app-shell";
import { Suspense } from "react";
import { PlansBody } from "@/components/plans/plans-body";
import { requireSession } from "@/components/app-shell";

export default function PlansPage() {
  return (
    <AppShell titleKey="plan.title" subtitleKey="plan.subtitle">
      <Suspense fallback={<div className="h-96 animate-pulse rounded-lg bg-[var(--muted)]" />}>
        <PlansBody />
      </Suspense>
    </AppShell>
  );
}
