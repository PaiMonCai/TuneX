import { AppShell } from "@/components/app-shell";
import { ForwardWorkspace } from "@/components/forwards/forward-workspace";

export default function ForwardsPage() {
  return (
    <AppShell titleKey="forward.title" subtitleKey="forward.subtitle">
      <ForwardWorkspace />
    </AppShell>
  );
}
