import { AppShell } from "@/components/app-shell";
import { Suspense } from "react";
import { TicketsBody } from "@/components/tickets/tickets-body";
import { requireSession } from "@/components/app-shell";

export default function TicketsPage() {
  return (
    <AppShell titleKey="common.tickets" subtitleKey="tickets.subtitle">
      <Suspense fallback={<div className="h-96 animate-pulse rounded-lg bg-[var(--muted)]" />}>
        <TicketsBody />
      </Suspense>
    </AppShell>
  );
}
