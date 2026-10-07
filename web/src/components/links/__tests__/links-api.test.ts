import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, API_MOCK, setActiveWorkspace } from "@/lib/api/core";
import { linksApi, linkErrorInfo } from "@/lib/links-api";
import { projectLinkDetail, projectLinkList, LinksPayloadError } from "@/lib/links-types";
import { binding, link } from "./links-fixtures";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; setActiveWorkspace(null); });
describe("real links API transport contract", () => {
  test("all mutations retain explicit tenant, cookie credentials, CSRF and revision CAS", async () => {
    expect(API_MOCK).toBe(false);
    setActiveWorkspace(99); // Explicit captured workspace must win, including after a UI switch.
    const calls: { path: string; method: string; body: unknown }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["x-workspace-id"]).toBe("5");
      expect(init?.credentials).toBe("include");
      const method = init?.method ?? "GET";
      if (method !== "GET") expect(headers["X-CSRF-Token"]).toBe("1");
      calls.push({ path: String(url).split("/api")[1], method, body: init?.body ? JSON.parse(String(init.body)) : null });
      const payload = method === "DELETE" ? { id: 3, status: "retired" }
        : String(url).endsWith("/forwards") ? { id: 7, link_id: 3 }
        : String(url).endsWith("/links") && method === "GET" ? [link()] : link();
      return Response.json({ data: payload });
    }) as typeof fetch;
    await linksApi.list(5); await linksApi.detail(5, 3);
    await linksApi.create(5, { name: "Tunnel", config: link().config! });
    await linksApi.updateConfig(5, 3, 2, link().config!);
    await linksApi.deploy(5, 3); await linksApi.rotateKey(5, 3); await linksApi.retire(5, 3);
    await linksApi.createForward(5, 3, binding);
    await linksApi.updateForward(5, 3, 7, 8, binding);
    for (const action of ["suspend", "resume", "retry", "delete"] as const) await linksApi.actionForward(5, 3, 7, action);
    expect(calls.slice(0, 9)).toEqual([
      { path: "/links", method: "GET", body: null }, { path: "/links/3", method: "GET", body: null },
      { path: "/links", method: "POST", body: { name: "Tunnel", config: link().config! } },
      { path: "/links/3/config", method: "PUT", body: { expected_version: 2, config: link().config! } },
      { path: "/links/3/deploy", method: "POST", body: null }, { path: "/links/3/rotate-key", method: "POST", body: null },
      { path: "/links/3", method: "DELETE", body: null }, { path: "/links/3/forwards", method: "POST", body: binding },
      { path: "/links/3/forwards/7", method: "PUT", body: { expected_revision: 8, binding } },
    ]);
    expect(calls.slice(9).map((call) => call.body)).toEqual(["suspend", "resume", "retry", "delete"].map((action) => ({ action })));
  });
  test("feature-off response is an error, not a fabricated resource", async () => {
    globalThis.fetch = (async () => Response.json({ code: "fxp_links_not_enabled", error: "fxp_links_not_enabled" }, { status: 409 })) as typeof fetch;
    let failure: unknown;
    try { await linksApi.create(5, { name: "Tunnel", config: link().config! }); } catch (error) { failure = error; }
    expect(linkErrorInfo(failure)).toMatchObject({ code: "fxp_links_not_enabled", disabled: true, conflict: false });
  });
  test("version conflicts and partial apply failures retain safe codes", () => {
    expect(linkErrorInfo(new ApiError(409, "secret config", { code: "revision_conflict" })).conflict).toBe(true);
    expect(linkErrorInfo(new ApiError(409, "secret config", { code: "link_version_conflict" })).conflict).toBe(true);
    expect(linkErrorInfo(new ApiError(503, "key=hidden", { code: "bad key=hidden" })).code).toBe("link_request_failed");
  });
  test("reject another workspace and malformed protocol; strip extra secret fields", () => {
    expect(() => projectLinkDetail(link({ workspace_id: 8 }), 5)).toThrow(LinksPayloadError);
    expect(() => projectLinkList({}, 5)).toThrow(LinksPayloadError);
    const raw = { ...link(), key: "private", runner_config: { key: "private" }, secret_enc: "private" };
    expect(JSON.stringify(projectLinkDetail(raw, 5))).not.toContain("private");
    expect(() => projectLinkDetail({ ...raw, forwards: [{ ...raw.forwards[0], forward_protocol: "tls" }] }, 5)).toThrow(LinksPayloadError);
  });
  test("legacy count projection and detail forwards remain authoritative", () => {
    const raw = { ...link(), ref_count: undefined, _count: { forwards: 4 } };
    expect(projectLinkList([raw], 5)[0].ref_count).toBe(4);
    expect(projectLinkDetail({ ...raw, _count: undefined }, 5).ref_count).toBe(1);
  });
  test("an incomplete successful HTTP response is not a confirmed mutation", async () => {
    globalThis.fetch = (async () => Response.json({ data: null })) as typeof fetch;
    await expect(linksApi.createForward(5, 3, binding)).rejects.toThrow(LinksPayloadError);
    await expect(linksApi.retire(5, 3)).rejects.toThrow(LinksPayloadError);
    globalThis.fetch = (async () => Response.json({ data: link({ id: 4 }) })) as typeof fetch;
    await expect(linksApi.deploy(5, 3)).rejects.toThrow(LinksPayloadError);
  });
  test("observation is a closed projection and ready=false is preserved", () => {
    const raw = link(); raw.deployment!.placements[0].observation = { state: "passive", ready: false, observed_generation: 4 };
    const p = raw.deployment!.placements[0];
    const projected = projectLinkDetail({ ...raw, deployment: { ...raw.deployment,
      placements: [{ ...p, observation: { ...p.observation, runner_config: { key: "never-visible" } } }] } }, 5);
    expect(projected.deployment!.placements[0].observation).toEqual({ state: "passive", ready: false, observed_generation: 4 });
    expect(JSON.stringify(projected)).not.toContain("never-visible");
    expect(() => projectLinkDetail({ ...raw, deployment: { ...raw.deployment,
      placements: [{ ...p, observation: { state: "ready", ready: "true", observed_generation: 4 } }] } }, 5)).toThrow(LinksPayloadError);
  });
  test("policy-blocked deployment preserves degraded resource and removed observation", () => {
    const raw = link({ status: "degraded" }); raw.deployment!.status = "policy_blocked";
    raw.deployment!.placements[0].observation = { state: "removed", ready: false, observed_generation: 4 };
    const projected = projectLinkDetail(raw, 5);
    expect(projected.status).toBe("degraded"); expect(projected.deployment!.status).toBe("policy_blocked");
    expect(projected.deployment!.placements[0].observation).toEqual({ state: "removed", ready: false, observed_generation: 4 });
  });
});
