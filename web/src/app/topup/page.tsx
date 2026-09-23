import { AppShell } from "@/components/app-shell";
import { Suspense } from "react";
import { TopupBody } from "@/components/topup/topup-body";
import { requireSession } from "@/components/app-shell";

export default function TopupPage() {
  return (
    <AppShell titleKey="topup.title" subtitleKey="topup.subtitle">
      <Suspense fallback={<div className="h-96 animate-pulse rounded-lg bg-[var(--muted)]" />}>
        <TopupBody />
      </Suspense>
    </AppShell>
  );
}
