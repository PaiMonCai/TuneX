import { AppShell } from "@/components/app-shell";
import { NodeWorkspace } from "@/components/nodes/node-workspace";

export default function NodesPage() {
  return (
    <AppShell titleKey="node.title" subtitleKey="node.subtitle">
      <NodeWorkspace />
    </AppShell>
  );
}
