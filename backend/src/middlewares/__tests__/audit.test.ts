import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  normalizePath,
  analyzePath,
  buildAction,
  isSensitivePath,
  shouldAudit,
  classifyActor,
  buildAuditEntry,
  setAuditSink,
  resetAuditSink,
  writeAudit,
  type AuditEntry,
  type AuditSink,
} from "../../services/audit.ts";

describe("normalizePath", () => {
  test("numeric segments become :id and query is stripped", () => {
    expect(normalizePath("/api/tunnels/42/traffic?days=7")).toBe("/api/tunnels/:id/traffic");
  });
  test("keeps non-numeric segments", () => {
    expect(normalizePath("/api/admin/users")).toBe("/api/admin/users");
  });
});

describe("analyzePath", () => {
  test("resource + resource_id from numeric segment", () => {
    expect(analyzePath("/api/admin/users/5/roles")).toEqual({
      resource: "admin/users",
      resourceId: "5",
    });
  });
  test("no id present", () => {
    expect(analyzePath("/api/tunnels")).toEqual({ resource: "tunnels", resourceId: null });
  });
  test("non-api root", () => {
    expect(analyzePath("/healthz")).toEqual({ resource: "healthz", resourceId: null });
  });
});

describe("buildAction", () => {
  test("method + normalized path, truncated to 191", () => {
    expect(buildAction("post", "/api/tunnels/1")).toBe("POST /api/tunnels/:id");
  });
});

describe("isSensitivePath", () => {
  test("flags login / token / callback / payment", () => {
    expect(isSensitivePath("/api/auth/login")).toBe(true);
    expect(isSensitivePath("/api/auth/reset")).toBe(true);
    expect(isSensitivePath("/api/pay/epay/callback?sign=abc")).toBe(true);
  });
  test("plain resources are not sensitive", () => {
    expect(isSensitivePath("/api/tunnels")).toBe(false);
    expect(isSensitivePath("/api/admin/plans")).toBe(false);
  });
});

describe("shouldAudit", () => {
  test("writes on all non-GET api calls", () => {
    expect(shouldAudit("/api/tunnels", "POST")).toBe(true);
    expect(shouldAudit("/api/admin/users/3", "DELETE")).toBe(true);
  });
  test("skips noisy user GETs", () => {
    expect(shouldAudit("/api/dashboard", "GET")).toBe(false);
    expect(shouldAudit("/api/auth/me", "GET")).toBe(false);
  });
  test("keeps admin GETs", () => {
    expect(shouldAudit("/api/admin/users", "GET")).toBe(true);
  });
  test("does not log reading the audit log itself", () => {
    expect(shouldAudit("/api/admin/audit-logs", "GET")).toBe(false);
  });
  test("skips health/socket/static", () => {
    expect(shouldAudit("/healthz", "GET")).toBe(false);
    expect(shouldAudit("/socket.io/", "POST")).toBe(false);
    expect(shouldAudit("/_next/static/x", "GET")).toBe(false);
    expect(shouldAudit("/", "GET")).toBe(false);
  });
  test("keeps sensitive auth endpooints even on GET", () => {
    expect(shouldAudit("/api/auth/login", "GET")).toBe(true);
  });
});

describe("classifyActor", () => {
  test("null → anonymous", () => {
    expect(classifyActor(null)).toBe("anonymous");
  });
  test("super_admin wins", () => {
    expect(classifyActor({ id: 1, super_admin: true, admin_roles: [{}] })).toBe("super_admin");
  });
  test("admin with roles", () => {
    expect(classifyActor({ id: 1, super_admin: false, admin_roles: [{ id: 2 }] })).toBe("admin");
  });
  test("plain user", () => {
    expect(classifyActor({ id: 1, super_admin: false, admin_roles: [] })).toBe("user");
  });
});

describe("buildAuditEntry", () => {
  test("captures actor, resource, id, status and truncates", () => {
    const e = buildAuditEntry({
      method: "PATCH",
      path: "/api/admin/users/5?x=1",
      status: 200,
      ip: "203.0.113.7",
      userAgent: "curl/8",
      user: { id: 5, email: "u@tunex.local", super_admin: true },
    });
    expect(e.actor_type).toBe("super_admin");
    expect(e.actor_id).toBe(5);
    expect(e.resource).toBe("admin/users");
    expect(e.resource_id).toBe("5");
    expect(e.action).toBe("PATCH /api/admin/users/:id");
    expect(e.path).toBe("/api/admin/users/5");
    expect(e.status).toBe(200);
    expect(e.ip).toBe("203.0.113.7");
  });

  test("anonymous request has null actor", () => {
    const e = buildAuditEntry({ method: "POST", path: "/api/auth/login", status: 401 });
    expect(e.actor_type).toBe("anonymous");
    expect(e.actor_id).toBeNull();
    expect(e.resource).toBe("auth/login");
  });

  test("metadata dropped on sensitive paths (never logs credentials)", () => {
    const e = buildAuditEntry({
      method: "POST",
      path: "/api/auth/login",
      status: 200,
      metadata: { password: "hunter2" },
    });
    expect(e.metadata).toBeNull();
  });

  test("metadata preserved on non-sensitive paths", () => {
    const e = buildAuditEntry({
      method: "PATCH",
      path: "/api/admin/plans/2",
      status: 200,
      metadata: { fields: ["price"] },
    });
    expect(e.metadata).toEqual({ fields: ["price"] });
  });
});

describe("writeAudit", () => {
  let captured: AuditEntry[];
  const sink: AuditSink = {
    write: async (entry) => {
      captured.push(entry);
    },
  };

  beforeEach(() => {
    captured = [];
    setAuditSink(sink);
  });
  afterEach(() => resetAuditSink());

  test("delegates to the configured sink", async () => {
    await writeAudit(buildAuditEntry({ method: "POST", path: "/api/tunnels", status: 201 }));
    expect(captured).toHaveLength(1);
    expect(captured[0].resource).toBe("tunnels");
  });

  test("a failing sink never throws (audit is best-effort)", async () => {
    setAuditSink({
      write: async () => {
        throw new Error("db down");
      },
    });
    await expect(writeAudit(buildAuditEntry({ method: "POST", path: "/api/tunnels", status: 500 }))).resolves.toBeUndefined();
  });
});
