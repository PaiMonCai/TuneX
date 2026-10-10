import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { projectMaintenanceCommit, projectMaintenanceList, projectMaintenanceMigration } from "@/lib/link-maintenance-migrations";
import { projectLinkMaintenancePreview } from "@/lib/link-maintenance-types";
import { linksApi } from "@/lib/links-api";
import { linksCopy } from "../links-copy";
import { LinkMaintenancePlans } from "../link-maintenance-plans";
import { maintenancePreview } from "./maintenance-fixtures";
import { link } from "./links-fixtures";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const created_at = "2026-10-10T02:00:00.000Z";
const request = { expected_version: 2, expected_generation: 4, change: { type: "rotate_key" as const } };
const receipt = "lm1.e30." + "ab".repeat(32);
const input = { ...request, receipt, idempotency_key: "4fcd5c30-8ee9-4a1e-8dc5-64267c5ee04a" };
const migration = (extra: Record<string, unknown> = {}) => ({ schema_version: 1, id: 19, link_id: 3, workspace_id: 5, created_by: 8,
  operation: "rotate_key", status: "awaiting_executor", state_version: 1, expected_version: 2, expected_generation: 4,
  candidate_config: { ingress_node_id: 11, egress_node_id: 12, carrier_port: 25000 },
  references: { total: 2, active: 1, suspended: 1 }, created_at, updated_at: created_at,
  hold_expires_at: "2026-10-10T02:05:00.000Z", reason_code: null,
  execution: { supported: false }, ports: { reserved: false, availability: "not_checked" }, ...extra });

describe("F5 durable plan closed client contract", () => {
  test("preview opt-in receipt is optional for legacy, required when submission supported, and never execution", () => {
    const row = link({ desired_version: 2, generation: 4 });
    const preview = maintenancePreview(row, request);
    const result = projectLinkMaintenancePreview({ ...preview, snapshot: { ...preview.snapshot, receipt },
      submission: { supported: true, hold_seconds: 300, secret: "must-not-retain" } }, 5, row.id, request);
    expect(result.snapshot.receipt).toBe(receipt);expect(result.submission).toEqual({ supported: true, hold_seconds: 300 });
    expect(result.execution.supported).toBe(false);
    for (const bad of ["", "unsigned", "lm1.payload.bad"]) expect(() => projectLinkMaintenancePreview({ ...preview,
      snapshot: { ...preview.snapshot, receipt: bad }, submission: { supported: true, hold_seconds: 300 } }, 5, row.id, request)).toThrow();
    expect(projectLinkMaintenancePreview(preview, 5, row.id, request).submission).toBeUndefined();
  });
  test("strict commit copies full CAS and receipt but rejects unknown fields and invalid UUID", () => {
    expect(projectMaintenanceCommit(input)).toEqual(input);
    for (const extra of [{ secret: "private" }, { execute: true }, { idempotency_key: "random" }, { receipt: "unsigned" }])
      expect(() => projectMaintenanceCommit({ ...input, ...extra })).toThrow();
  });
  test("metadata retains truthful state and strips snapshots, targets, receipts and credentials", () => {
    const row = projectMaintenanceMigration(migration({ snapshot: { key: "private" }, receipt, runner_config: { key: "private" },
      candidate_config: { ingress_node_id: 11, egress_node_id: 12, carrier_port: 25000, target_host: "must-not-retain" } }), 5, 3);
    expect(row.status).toBe("awaiting_executor");expect(row.references.suspended).toBe(1);
    expect(JSON.stringify(row)).not.toContain("private");expect(JSON.stringify(row)).not.toContain("must-not-retain");
    expect("receipt" in row).toBe(false);
  });
  test("another scope, manufactured success, reserved ports or malformed state/time are refused", () => {
    for (const extra of [{ workspace_id: 6 }, { link_id: 4 }, { status: "completed" }, { state_version: 2 },
      { execution: { supported: true } }, { ports: { reserved: true, availability: "available" } },
      { status: "cancelled", state_version: 1 }, { hold_expires_at: "2026-10-10T02:06:00.000Z" },
      { updated_at: "2026-10-10T01:59:00.000Z" }, { references: { total: 2, active: 2, suspended: 1 } },
      { reason_code: "raw key=must-not-leak" }]) expect(() => projectMaintenanceMigration(migration(extra), 5, 3)).toThrow();
    for (const status of ["cancelled", "invalidated", "expired"]) expect(projectMaintenanceMigration(migration({ status, state_version: 2 }), 5, 3).status).toBe(status);
  });
  test("history bounds and duplicate IDs fail closed", () => {
    expect(projectMaintenanceList([], 5, 3)).toEqual([]);
    expect(() => projectMaintenanceList([migration(), migration()], 5, 3)).toThrow();
    expect(() => projectMaintenanceList(Array.from({ length: 21 }, (_, i) => migration({ id: i + 1 })), 5, 3)).toThrow();
  });
  test("real request layer keeps Workspace, CSRF/cookies, no-store, UUID replay and cancel CAS", async () => {
    const calls: { path: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init: RequestInit) => {
      const path = String(url);calls.push({ path, init });
      const data = init.method === "POST" ? path.endsWith("/cancel") ? migration({ status: "cancelled", state_version: 2 })
        : { migration: migration(), replayed: calls.filter((c) => c.path === path && c.init.method === "POST").length > 1 } : [migration()];
      return Response.json({ data });
    }) as typeof fetch;
    expect((await linksApi.listMaintenance(5, 3)).length).toBe(1);
    expect((await linksApi.commitMaintenance(5, 3, input)).replayed).toBe(false);
    expect((await linksApi.commitMaintenance(5, 3, input)).replayed).toBe(true);
    expect((await linksApi.cancelMaintenance(5, 3, 19, 1)).status).toBe("cancelled");
    for (const call of calls) { expect(new Headers(call.init.headers).get("x-workspace-id")).toBe("5");
      expect(call.init.credentials).toBe("include");expect(call.init.cache).toBe("no-store"); }
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual(input);
    expect(JSON.parse(calls.at(-1)!.init.body as string)).toEqual({ expected_state_version: 1 });
    expect(new Headers(calls[1]!.init.headers).has("X-CSRF-Token")).toBe(true);
  });
  test("HTTP success is rejected if it invents commit/cancel results", async () => {
    globalThis.fetch = (async () => Response.json({ data: { migration: migration(), replayed: "yes" } })) as typeof fetch;
    await expect(linksApi.commitMaintenance(5, 3, input)).rejects.toThrow();
    const moved = { ...input, change: { type: "update_endpoints" as const,
      config: { ingress_node_id: 11, egress_node_id: 12, carrier_port: 25001 } } };
    globalThis.fetch = (async () => Response.json({ data: { migration: migration({ operation: "update_endpoints" }), replayed: false } })) as typeof fetch;
    await expect(linksApi.commitMaintenance(5, 3, moved)).rejects.toThrow();
    globalThis.fetch = (async () => Response.json({ data: migration() })) as typeof fetch;
    await expect(linksApi.cancelMaintenance(5, 3, 19, 1)).rejects.toThrow();
  });
  test("bilingual plan UI explicitly describes no execution and a logical-only bounded fence", () => {
    for (const locale of ["zh", "en"] as const) {
      const copy = linksCopy(locale);
      const html = renderToStaticMarkup(<LinkMaintenancePlans workspaceId={5} linkId={3} epoch={0} now={Date.parse(created_at)}
        copy={copy} canManage={false} busy={false} onPendingChange={() => {}} onCancel={async () => false} />);
      expect(html).toContain(copy.maintenancePlans);expect(html).toContain(copy.maintenancePlanHint);
      expect(html).toContain(copy.maintenancePlanNoExecution);expect(html).not.toContain("<button");
    }
  });
});
