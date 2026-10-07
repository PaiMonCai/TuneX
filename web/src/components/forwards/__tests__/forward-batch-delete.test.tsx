import { afterEach, beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ForwardBatchBar } from "../forward-batch-bar";
import { prepareForwardBatchRequest, submitForwardBatch } from "../forward-batch-model";
import { forwardListText } from "../forward-list-model";
import { handleMock } from "@/mocks/handler";
import { getStore, resetStore } from "@/mocks/state";
import type { ForwardBatchResult } from "@/lib/types";

const oldFlag = process.env.NEXT_PUBLIC_MOCK_FORWARD_BATCH_DELETE_ENABLED;
beforeEach(() => { resetStore(); delete process.env.NEXT_PUBLIC_MOCK_FORWARD_BATCH_DELETE_ENABLED; });
afterEach(() => {
  if (oldFlag === undefined) delete process.env.NEXT_PUBLIC_MOCK_FORWARD_BATCH_DELETE_ENABLED;
  else process.env.NEXT_PUBLIC_MOCK_FORWARD_BATCH_DELETE_ENABLED = oldFlag;
});
const text = (key: Parameters<typeof forwardListText>[2], params?: Record<string, string | number>) =>
  forwardListText((key) => key, "zh", key, params);
const response: ForwardBatchResult = {
  action: "delete", requested: 1, succeeded: 1, failed: 0,
  results: [{ id: 1, ok: true, apply_status: null }],
};
const input = { action: "delete" as const, ids: [1], confirm_delete: true as const };

test("delete button is opt-in; delete-only grant does not enable update actions", () => {
  const props = { count: 2, busy: false, error: null, text, onRun: () => {}, onClear: () => {} };
  expect(renderToStaticMarkup(<ForwardBatchBar {...props} />)).not.toContain('data-testid="forward-batch-delete"');
  const html = renderToStaticMarkup(<ForwardBatchBar {...props} canUpdate={false} canDelete error={"ID 2: teardown failed\nID 3: forbidden"} />);
  expect(html).toContain('data-testid="forward-batch-delete"');
  expect(html).toMatch(/data-testid="forward-batch-retry"[^>]*disabled/);
  expect(html).toContain("ID 2: teardown failed");
  expect(html).toContain("ID 3: forbidden");
  const busy = renderToStaticMarkup(<ForwardBatchBar {...props} canDelete busy />);
  expect(busy).toMatch(/data-testid="forward-batch-delete"[^>]*disabled/);
});

test("remote reconciliation warning stays visible after locally deleted rows leave the selection", () => {
  const html = renderToStaticMarkup(
    <ForwardBatchBar
      count={0}
      busy={false}
      error={"1 条已完成本地删除，但远端释放仍待对账\nID 7: remote release pending"}
      text={text}
      onRun={() => {}}
      onClear={() => {}}
    />,
  );
  expect(html).toContain('data-testid="forward-batch-bar"');
  expect(html).toContain('data-testid="forward-batch-error"');
  expect(html).toContain("远端释放仍待对账");
});

test("cancel creates no destructive request; confirmation captures immutable selected IDs", () => {
  expect(prepareForwardBatchRequest("delete", [1], () => false)).toBeNull();
  const ids = [1, 2];
  const body = prepareForwardBatchRequest("delete", ids, () => true);
  ids.push(3);
  expect(body).toEqual({ action: "delete", ids: [1, 2], confirm_delete: true });
  expect(prepareForwardBatchRequest("resume", [1], () => { throw Error("must not confirm reversible action"); }))
    .toEqual({ action: "resume", ids: [1] });
});

test("own-scope cross-page permission checks use delete, not update", async () => {
  const checks: [number, string][] = [];
  let sends = 0;
  await expect(submitForwardBatch({ ...input, ids: [1, 8] }, {
    current: () => true, deniedMessage: "denied",
    verifyOwnership: async (id, action) => { checks.push([id, action]); return id === 1; },
    send: async () => { sends++; return response; },
  })).rejects.toThrow("denied");
  expect(checks).toEqual([[1, "delete"], [8, "delete"]]);
  expect(sends).toBe(0);
});

test("scope change while checking ownership prevents sending; late results are discarded", async () => {
  let active = true, sends = 0;
  const result = await submitForwardBatch(input, {
    current: () => active, deniedMessage: "denied",
    verifyOwnership: async () => { active = false; return true; },
    send: async () => { sends++; return response; },
  });
  expect(result).toBeNull(); expect(sends).toBe(0);
  active = true;
  expect(await submitForwardBatch(input, {
    current: () => active, deniedMessage: "denied",
    send: async () => { active = false; return response; },
  })).toBeNull();
});

const call = (method: string, path: string, body?: unknown, actor = 1, workspaceId?: number) =>
  handleMock(method, path, { body, cookie: `tunex_session=u${actor}`, workspaceId });

test("mock shares default-off, confirmation, deduplication and per-ID results", async () => {
  let capability = await call("GET", "/forwards/batch/capabilities");
  expect((capability.body as { delete_enabled: boolean }).delete_enabled).toBe(false);
  expect((await call("POST", "/forwards/batch", { action: "delete", ids: [1] })).status).toBe(400);
  expect((await call("POST", "/forwards/batch", input)).status).toBe(409);
  process.env.NEXT_PUBLIC_MOCK_FORWARD_BATCH_DELETE_ENABLED = "true";
  capability = await call("GET", "/forwards/batch/capabilities");
  expect((capability.body as { delete_enabled: boolean }).delete_enabled).toBe(true);
  const row = getStore().tunnels.find((r) => r.user_id === 1)!;
  const result = await call("POST", "/forwards/batch", { action: "delete", ids: [row.id, row.id, 999999], confirm_delete: true });
  expect(result.status).toBe(200);
  const body = result.body as ForwardBatchResult;
  expect([body.requested, body.succeeded, body.failed]).toEqual([2, 1, 1]);
  expect(body.results[0]).toEqual({ id: row.id, ok: true, apply_status: null });
  expect(body.results[1].code).toBe("not_found");
  expect(getStore().tunnels.some((r) => r.id === row.id)).toBe(false);
});

test("mock member cannot batch-delete other creators; update grant cannot replace delete", async () => {
  process.env.NEXT_PUBLIC_MOCK_FORWARD_BATCH_DELETE_ENABLED = "true";
  const db = getStore();
  const teamId = db.workspaces.find((w) => w.kind === "team")!.id;
  const own = db.tunnels[0], other = db.tunnels[1];
  own.user_id = 3; other.user_id = 8;
  const result = await call("POST", "/forwards/batch", { action: "delete", ids: [own.id, other.id], confirm_delete: true }, 3, teamId);
  expect(result.status).toBe(200);
  expect((result.body as ForwardBatchResult).results.map((r) => [r.id, r.ok, r.code ?? null]))
    .toEqual([[own.id, true, null], [other.id, false, "forbidden"]]);
  const role = await call("POST", `/workspaces/${teamId}/roles`, { name: "update-only", permissions: { "forward:read": true, "forward:update": true } });
  const roleId = (role.body as { id: number }).id;
  await call("PATCH", `/workspaces/${teamId}/members/2/role`, { role_id: roleId });
  expect((await call("POST", "/forwards/batch", input, 2, teamId)).status).toBe(403);
});
