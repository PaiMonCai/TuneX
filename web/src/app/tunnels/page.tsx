import { AppShell } from "@/components/app-shell";
import { Suspense } from "react";
import { TunnelList } from "@/components/tunnels/tunnel-list";

export default function TunnelsPage() {
  return (
    <AppShell titleKey="tunnel.title" subtitleKey="tunnel.subtitle">
      <Suspense fallback={<div className="h-96 animate-pulse rounded-lg bg-[var(--muted)]" />}>
        <TunnelList />
      </Suspense>
    </AppShell>
  );
}
