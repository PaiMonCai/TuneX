/**
 * `POST /node-groups/:id/nodes` 的同名语义：mock 与真实后端一致。
 *
 * 这条守卫来自 E2 独立复核的 F6：mock 原来对**任何**同名 `node_id` 直接回
 * 409 `NODE_EXISTS`，而真实后端 `routes/node-groups.ts:217-234` 对**同组同名**是
 * **201 重签**（同一行、同一个 id，只有一次性 enrollment 重新签发）。而"同名重装
 * 会撤销旧命令、节点身份不变"恰恰是本切片文案要让用户理解的安全路径 —— mock 把它
 * 演示成"报错"就等于在开发期把这条路径整条藏起来。
 *
 * 同时钉住两件容易一起跑偏的事：
 *   · 跨组同名仍然是 409（后端那里响应体是扁平 `{ error }`，没有 code）；
 *   · 端口区间只约束**新建行**：重签一个已存在的节点不看组区间（与后端同序）。
 *
 * 跑法（web 目录）：bun test src/mocks/__tests__/node-provision-mock-parity.test.ts
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { handleMock } from "@/mocks/handler";
import { getStore, resetStore } from "@/mocks/state";

const PERSONAL_WS = 1;
const session = (userId: number) => `tunex_session=u${userId}`;

async function call(method: string, path: string, body?: unknown) {
  return handleMock(method, path, {
    body,
    query: {},
    cookie: session(1),
    workspaceId: PERSONAL_WS,
  } as never);
}

/** 建一个可选带区间的新组，返回它的 id。 */
async function createGroup(name: string, portRange?: string): Promise<number> {
  const res = await call("POST", "node-groups", {
    name,
    node_type: "in",
    ...(portRange === undefined ? {} : { port_range: portRange }),
  });
  expect(res.status).toBe(201);
  return (res.body as { data: { id: number } }).data.id;
}

beforeEach(() => {
  resetStore();
});

describe("mock 的同名语义 = 真实后端：同组同名是 201 重签", () => {
  test("同名第二次 → 201，同一行/同一个 id，只是重新签发 enrollment", async () => {
    const groupId = await createGroup("重签组", "31000-31999");
    const before = getStore().nodes.filter((node) => node.node_id === "resign-node").length;

    const first = await call("POST", `node-groups/${groupId}/nodes`, { node_id: "resign-node" });
    expect(first.status).toBe(201);
    const firstBody = first.body as { node: { id: number }; enrollment: { token: string } };
    expect(typeof firstBody.enrollment.token).toBe("string");

    const second = await call("POST", `node-groups/${groupId}/nodes`, { node_id: "resign-node" });
    // 不是 409：同名 = 重签，而不是报错。
    expect(second.status).toBe(201);
    const secondBody = second.body as { node: { id: number }; enrollment: { token: string } };
    expect(secondBody.node.id).toBe(firstBody.node.id);

    // 命令被重新签发（旧的一次性 token 不再出现在响应里）。
    expect(typeof secondBody.enrollment.token).toBe("string");
    expect(secondBody.enrollment.token).not.toBe(firstBody.enrollment.token);

    // 没有多出第二行。
    const after = getStore().nodes.filter((node) => node.node_id === "resign-node").length;
    expect(after).toBe(before + 1);
  });

  test("响应形状 = 客户端可见的 `ProvisionNodeResult`：201 + `{ node, enrollment }`", async () => {
    // mock 的 body 约定是"剥掉一层 data 之后的视图"（同 `GET /nodes`）。真实后端
    // provision 的原始报文是 `{ data: { node, enrollment } }`，api 层 `post()` 剥掉
    // 那层 data；两条路径都必须给出同一个客户端可见形状，且创建与重签完全一致。
    const groupId = await createGroup("形状组", "32000-32999");
    const created = await call("POST", `node-groups/${groupId}/nodes`, { node_id: "shape-node" });
    expect(created.status).toBe(201);
    const createdBody = created.body as Record<string, unknown>;
    expect(Object.keys(createdBody).sort()).toEqual(["enrollment", "node"]);
    expect((createdBody.node as { node_id: string }).node_id).toBe("shape-node");
    expect(typeof (createdBody.enrollment as { token: string }).token).toBe("string");

    // 重签路径（同组同名）给**同一个形状**：这也是合跑时曾经炸掉的那条路径。
    const resigned = await call("POST", `node-groups/${groupId}/nodes`, { node_id: "shape-node" });
    expect(resigned.status).toBe(201);
    const resignedBody = resigned.body as Record<string, unknown>;
    expect(Object.keys(resignedBody).sort()).toEqual(["enrollment", "node"]);
    expect((resignedBody.node as { node_id: string }).node_id).toBe("shape-node");
    expect(typeof (resignedBody.enrollment as { token: string }).token).toBe("string");
  });

  test("跨组同名仍然 409，且响应体是后端的扁平 `{ error }`（没有 code）", async () => {
    const groupA = await createGroup("A 组", "33000-33999");
    const groupB = await createGroup("B 组", "34000-34999");

    const res = await call("POST", `node-groups/${groupA}/nodes`, { node_id: "shared-node" });
    expect(res.status).toBe(201);

    const conflict = await call("POST", `node-groups/${groupB}/nodes`, { node_id: "shared-node" });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ error: "node_id 已被其它节点组占用" });
    // 跨组冲突不得新建第二行。
    expect(getStore().nodes.filter((node) => node.node_id === "shared-node").length).toBe(1);
  });

  test("端口区间只约束新建行：无区间的组里重签已存在的节点仍是 201", async () => {
    const groupId = await createGroup("先有区间再取消", "35000-35999");
    const created = await call("POST", `node-groups/${groupId}/nodes`, { node_id: "range-then-none" });
    expect(created.status).toBe(201);

    // 模拟"组区间后来被清掉"（后端只对**新**行判区间）。
    const group = getStore().nodeGroups.find((row) => row.id === groupId)!;
    group.port_range = null;

    const resign = await call("POST", `node-groups/${groupId}/nodes`, { node_id: "range-then-none" });
    expect(resign.status).toBe(201);

    // 对照组：同一个组里**新建**另一个 node_id 仍然 409 PORT_RANGE_REQUIRED。
    const fresh = await call("POST", `node-groups/${groupId}/nodes`, { node_id: "range-none-new" });
    expect(fresh.status).toBe(409);
    expect((fresh.body as { code?: string }).code).toBe("PORT_RANGE_REQUIRED");
  });
});
