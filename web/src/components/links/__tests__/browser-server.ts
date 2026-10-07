/** Browser-only contract fixture. No database, no Agent or production credentials. */
import { resolve } from "node:path";
import { projectLinkTargetSet, type LinkBindingInput, type LinkDetail } from "@/lib/links-types";
import { link, statistics, targetLink } from "./links-fixtures";

const bundle = await Bun.build({ entrypoints: [resolve(import.meta.dir, "browser-entry.tsx")], target: "browser",
  define: { "process.env.NEXT_PUBLIC_API_MOCK": '"0"', "process.env.SERVER_API_BASE": '""', "process.env.NODE_ENV": '"development"' } });
if (!bundle.success) throw new Error(String(bundle.logs));
const js = await bundle.outputs[0].text();
let links: LinkDetail[] = [];
let enabled = true;
let conflict = false;
let partial = false;
let delay = false;
let targetsCapabilityMissing = false;
const calls: { path: string; method: string; workspaceId: number; body: unknown }[] = [];
const response = (data: unknown, status = 200) => Response.json({ data }, { status });
const failure = (code: string, status = 409) => Response.json({ code, error: code }, { status });
const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Links browser contract test</title>
<style>:root{--card:#fff;--card-foreground:#111;--border:#bbb;--foreground:#111;--muted-foreground:#555;--primary:#123;--primary-foreground:#fff;--input:#bbb;--destructive:#b00;--destructive-foreground:#fff}body{font:15px system-ui;margin:24px}main{max-width:1100px}button,input,select{font:inherit;padding:8px;margin:4px}dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}fieldset{margin:12px 0}article{border:1px solid #bbb;padding:12px;margin:12px 0}button:disabled{opacity:.4}[role=alert]{color:#900}h3{margin-top:24px}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;

Bun.serve({ hostname: "127.0.0.1", port: 41973, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === "/") return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  if (path === "/bundle.js") return new Response(js, { headers: { "Content-Type": "text/javascript" } });
  if (path === "/__test/f2-checks.js") return new Response(Bun.file(resolve(import.meta.dir, "browser-targets-checks.js")), { headers: { "Content-Type": "text/javascript" } });
  if (path === "/favicon.ico") return new Response(null, { status: 204 });
  if (path === "/__test/state") return response({ links, calls });
  if (path === "/__test/scenario") {
    const input = await req.json() as { enabled?: boolean; conflict?: boolean; partial?: boolean; delay?: boolean; reset?: boolean; targetsCapabilityMissing?: boolean;
      targetObservation?: "healthy" | "all_unavailable" | "stale" | "digest_mismatch" | "expired" | "missing" | "ingress_only" | "not_ready" | "probe_none" | "probe_none_silent" | "legacy" | "old_checked" | "future_checked" | "initial_unknown";
      statistics?: "idle" | "collecting" | "backlogged" | "blocked" | "unknown" };
    enabled = input.enabled ?? true; conflict = input.conflict ?? false; partial = input.partial ?? false; delay = input.delay ?? false;
    targetsCapabilityMissing = input.targetsCapabilityMissing ?? false;
    if (input.reset) { links = []; calls.length = 0; }
    if (input.targetObservation) {
      if (!links.length) links.push(targetLink());
      for (const row of links) {
        const scenario = input.targetObservation;
        if (scenario === "legacy") row.forwards.forEach((f) => { delete f.target_set; });
        if (scenario === "probe_none" || scenario === "probe_none_silent") row.forwards.forEach((f) => { if (f.target_set) f.target_set.probe = "none"; });
        const initialUnknown = scenario === "initial_unknown" || scenario === "probe_none_silent";
        row.deployment!.lease_expires_at = new Date(Date.now() + (scenario === "expired" ? -60000 : 180000)).toISOString();
        for (const placement of row.deployment!.placements) {
          const own = scenario === "ingress_only" ? placement.role === "ingress" : placement.role === "egress";
          const stripped = ["stale", "digest_mismatch", "missing", "legacy", "not_ready"].includes(scenario);
          placement.observation = {
            state: scenario === "stale" ? "stale" : scenario === "digest_mismatch" ? "mismatch" : scenario === "not_ready" ? "failed" : "ready",
            ready: !["stale", "digest_mismatch", "not_ready"].includes(scenario), observed_generation: row.generation,
            ...(own && !stripped ? { target_status: row.forwards.filter((f) => f.target_set).map((f) => ({
              forward_id: f.id, states: f.target_set!.targets.map(() => scenario === "all_unavailable" ? "unhealthy" as const : initialUnknown ? "unknown" as const : "healthy" as const),
              selected_tcp: f.forward_protocol === "udp" || initialUnknown ? null : 0,
              selected_udp: f.forward_protocol === "tcp" || initialUnknown ? null : f.target_set!.targets.length - 1,
              last_checked_at: initialUnknown ? null : new Date(Date.now() + (scenario === "old_checked" ? -61000 : scenario === "future_checked" ? 6000 : 0)).toISOString(),
              reason: scenario === "all_unavailable" ? "all_unavailable" as const : initialUnknown ? "initial" as const : "selected" as const,
            })) } : {}),
          };
        }
      }
    }
    if (input.statistics !== undefined) {
      if (!links.length) links.push(link());
      for (const row of links) for (const placement of row.deployment?.placements ?? []) {
        if (placement.role === "ingress") placement.observation = {
          state: "failed", ready: false, observed_generation: row.generation,
          ...(input.statistics === "unknown" ? {} : { traffic_status: statistics({
            state: input.statistics, last_ack_at: new Date().toISOString() }) }),
        };
      }
    }
    return response({ enabled, conflict, partial, delay, targetsCapabilityMissing });
  }
  const workspaceId = Number(req.headers.get("x-workspace-id"));
  if (![5, 6].includes(workspaceId)) return failure("permission_denied", 403);
  if (req.method !== "GET" && req.headers.get("X-CSRF-Token") !== "1") return failure("csrf_failed", 403);
  const body = req.method === "GET" || req.method === "DELETE" || !req.headers.get("Content-Type") ? null : await req.json();
  calls.push({ path, method: req.method, workspaceId, body });
  if (delay) await Bun.sleep(1200);
  if (path === "/api/nodes") return response([
    { id: 11, node_id: "Entry lab", role: "ingress", lifecycle: "active", accepts_new_business: true, connect_ip: "127.0.0.1" },
    { id: 12, node_id: "Exit lab", role: "egress", lifecycle: "active", accepts_new_business: true, connect_ip: "127.0.0.2" },
  ]);
  if (path === "/api/links" && req.method === "GET") return response(links.filter((row) => row.workspace_id === workspaceId));
  if (!enabled && req.method !== "GET") return failure("fxp_links_not_enabled");
  if (path === "/api/links" && req.method === "POST") {
    const input = body as { name: string; config: LinkDetail["config"] };
    const row = link({ id: links.length + 1, workspace_id: workspaceId, name: input.name, config: input.config,
      status: "draft", desired_version: 1, generation: 0, forwards: [], ref_count: 0, deployment: null });
    links.push(row); return response(row, 201);
  }
  const match = /^\/api\/links\/(\d+)(.*)$/.exec(path);
  const row = links.find((l) => l.id === Number(match?.[1]) && l.workspace_id === workspaceId);
  if (!row) return failure("link_not_found", 404);
  const suffix = match![2];
  if (!suffix && req.method === "GET") return response(row);
  if (!suffix && req.method === "DELETE") { if (row.forwards.length) return failure("link_has_references"); row.status = "retired"; return response({ id: row.id, status: "retired" }); }
  if (suffix === "/config") {
    const input = body as { expected_version: number; config: LinkDetail["config"] };
    if (conflict || input.expected_version !== row.desired_version) { conflict = false; row.desired_version++; return failure("link_version_conflict"); }
    if (row.forwards.length) return failure("link_has_references");
    if (row.generation > 0) return failure("link_config_requires_retirement");
    row.config = input.config; row.desired_version++; return response(row);
  }
  const fmatch = /^\/forwards\/(\d+)(\/actions)?$/.exec(suffix);
  if (suffix === "/forwards" || fmatch) {
    if (fmatch) {
      const f = row.forwards.find((f) => f.id === Number(fmatch[1])); if (!f) return failure("forward_not_found", 404);
      if (fmatch[2]) {
        const action = (body as { action: string }).action;
        if (action === "delete") row.forwards = row.forwards.filter((candidate) => candidate.id !== f.id);
        else { f.config_revision++; f.desired_status = action === "suspend" ? "inactive" : "active"; f.apply_status = action === "suspend" ? "suspended" : "active"; }
      } else {
        const input = body as { expected_revision: number; binding: LinkBindingInput };
        if (conflict || input.expected_revision !== f.config_revision) { conflict = false; f.config_revision++; return failure("revision_conflict"); }
        if (f.target_set && !input.binding.target_set) return failure("link_target_set_required");
        const invalid = validateBinding(input.binding); if (invalid) return invalid;
        Object.assign(f, project(input.binding), { config_revision: f.config_revision + 1 });
      }
    } else {
      const invalid = validateBinding(body as LinkBindingInput); if (invalid) return invalid;
      row.forwards.push({ id: row.forwards.length + 1, ...project(body as LinkBindingInput), config_revision: 1,
        applied_revision: null, desired_status: "active", apply_status: "pending" });
    }
    row.ref_count = row.forwards.length;
    if (partial) { partial = false; return failure("link_apply_unconfirmed"); }
  }
  if (["/deploy", "/rotate-key", "/forwards"].includes(suffix) || fmatch) {
    if (suffix === "/rotate-key" && row.forwards.length) return failure("link_has_references");
    row.status = "active"; row.generation++;
    row.forwards.forEach((f) => { f.applied_revision = f.config_revision; if (f.desired_status === "active") f.apply_status = "active"; });
    row.deployment = { generation: row.generation, status: "active", lease_expires_at: new Date(Date.now() + 180000).toISOString(), placements: ["ingress", "egress"].map((role) => ({
      node_id: role === "ingress" ? 11 : 12, role, generation: row.generation, applied_generation: row.generation,
      status: role === "ingress" && !row.forwards.some((f) => f.desired_status === "active") ? "passive" : "running", last_error_code: null, updated_at: null,
      observation: { state: role === "ingress" && !row.forwards.some((f) => f.desired_status === "active") ? "passive" : "ready",
        ready: role !== "ingress" || row.forwards.some((f) => f.desired_status === "active"), observed_generation: row.generation } })) };
    return response(suffix === "/forwards" ? { id: row.forwards.at(-1)!.id, link_id: row.id } : row);
  }
  return failure("route_not_found", 404);
} });
function project(binding: LinkBindingInput) {
  return { name: binding.name, forward_protocol: binding.protocol, listen_ip: binding.listen_host || "0.0.0.0", listen_port: binding.listen_port,
    remote_host: binding.target_host, remote_port: binding.target_port, bytes_per_second_in: binding.bytes_per_second_in,
    ...(binding.target_set ? { target_set: projectLinkTargetSet(binding.target_set) } : {}),
    bytes_per_second_out: binding.bytes_per_second_out, max_connections: binding.max_connections, max_connections_per_ip: binding.max_connections_per_ip };
}
function validateBinding(binding: LinkBindingInput): Response | null {
  if (binding.target_set) {
    if (targetsCapabilityMissing) return failure("agent_fxp_targets_capability_missing");
    try {
      const set = projectLinkTargetSet(binding.target_set);
      if (set.targets[0].host !== binding.target_host || set.targets[0].port !== binding.target_port) return failure("target_set_first_mismatch", 400);
    } catch { return failure("invalid_target_set", 400); }
  }
  return null;
}
console.log("links browser contract fixture http://127.0.0.1:41973");
