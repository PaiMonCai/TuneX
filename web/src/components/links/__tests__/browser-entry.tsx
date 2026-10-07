/** Isolated browser contract harness only; never imported by a product route. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceContext, type WorkspaceContextValue } from "@/components/workspace/workspace-context";
import { I18nProvider, getDictionary } from "@/components/providers";
import { LinksWorkspace } from "../links-workspace";

function Harness() {
  const [workspace, setWorkspace] = useState(5);
  const [manage, setManage] = useState(true);
  const context = {
    currentId: workspace, loading: false, permissionsLoading: false,
    permissions: { workspace_id: workspace, actor_id: 1, role: "owner", forward_mutations: "workspace", permissions: { "node:read": true, "node:manage": manage } },
    can: (key: string) => key === "node:read" || (["node:manage", "forward:create", "forward:update", "forward:delete"].includes(key) && manage),
  } as WorkspaceContextValue;
  return <I18nProvider locale="zh" dict={getDictionary("zh")}><WorkspaceContext.Provider value={context}>
    <div id="harness-controls"><button onClick={() => setWorkspace((id) => id === 5 ? 6 : 5)}>Switch test workspace</button>
      <button onClick={() => setManage((value) => !value)}>Toggle test permission</button></div>
    <main><LinksWorkspace /></main>
  </WorkspaceContext.Provider></I18nProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
