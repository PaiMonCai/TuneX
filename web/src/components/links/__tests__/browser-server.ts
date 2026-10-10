/** Browser-only contract fixture. No database, no Agent or production credentials. */
import { resolve } from "node:path";
import { projectLinkClientSource, projectLinkTargetSet, type LinkBindingInput, type LinkDetail } from "@/lib/links-types";
import { forward, link, statistics, targetLink } from "./links-fixtures";
import { maintenancePreview } from "./maintenance-fixtures";
import { projectLinkMaintenanceInput } from "@/lib/link-maintenance-types";
import { projectMaintenanceCommit, type LinkMaintenanceMigration } from "@/lib/link-maintenance-migrations";

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
let sourceError: string | null = null;
let previewError: string | null = null;
let previewDelay = false;
let previewLifetime = 60_000;
let previewTamper: "workspace" | "live" | "secret" | null = null;
let submission = false;
let plans: { row: LinkMaintenanceMigration; request: string; key: string }[] = [];
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
  if (path === "/__test/f3-checks.js") return new Response(Bun.file(resolve(import.meta.dir, "browser-client-source-checks.js")), { headers: { "Content-Type": "text/javascript" } });
  if (path === "/__test/f5-checks.js") return new Response(Bun.file(resolve(import.meta.dir, "browser-maintenance-checks.js")), { headers: { "Content-Type": "text/javascript" } });
  if (path === "/favicon.ico") return new Response(null, { status: 204 });
  if (path === "/__test/state") return response({ links, calls });
  if (path === "/__test/scenario") {
    const input = await req.json() as { enabled?: boolean; conflict?: boolean; partial?: boolean; delay?: boolean; reset?: boolean; targetsCapabilityMissing?: boolean; sourceError?: "link_client_source_required" | "agent_fxp_source_capability_missing" | "client_source_tcp_only" | "ip_hash_requires_client_source";
      maintenance?: boolean; maintenanceSecond?: boolean; previewError?: string; previewDelay?: boolean; previewLifetime?: number; previewTamper?: "workspace" | "live" | "secret";
      advance?: "version" | "generation" | "revision" | "remove";
      targetObservation?: "healthy" | "all_unavailable" | "stale" | "digest_mismatch" | "expired" | "missing" | "ingress_only" | "not_ready" | "probe_none" | "probe_none_silent" | "legacy" | "old_checked" | "future_checked" | "initial_unknown";
      statistics?: "idle" | "collecting" | "backlogged" | "blocked" | "unknown" };
    enabled = input.enabled ?? true; conflict = input.conflict ?? false; partial = input.partial ?? false; delay = input.delay ?? false;
    targetsCapabilityMissing = input.targetsCapabilityMissing ?? false;
    sourceError = input.sourceError ?? null;
    previewError = input.previewError ?? null; previewDelay = input.previewDelay ?? false;
    previewLifetime = input.previewLifetime ?? 60_000; previewTamper = input.previewTamper ?? null;
    submission = (input as { submission?: boolean }).submission ?? false;
    if (input.reset) { links = []; calls.length = 0; plans = []; }
    if (input.maintenance) links = [link({ forwards: [forward(), forward({ id: 8, name: "Desired suspended UDP", desired_status: "inactive", forward_protocol: "udp" })], ref_count: 2 })];
    if (submission) for (const row of links) row.deployment?.placements.forEach((p) => {
      p.observation = { state: "ready", ready: true, observed_generation: row.generation };
    });
    if (input.maintenanceSecond) links.push(link({ id: 4, name: "Second maintenance scope" }));
    if (input.advance) for (const row of links) {
      if (input.advance === "version") row.desired_version++;
      if (input.advance === "generation") row.generation++;
      if (input.advance === "revision") row.forwards[0].config_revision++;
      if (input.advance === "remove") { row.forwards.pop(); row.ref_count = row.forwards.length; }
    }
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
  if (!enabled && req.method !== "GET" && !/\/maintenance\/migrations\/\d+\/cancel$/.test(path)) return failure("fxp_links_not_enabled");
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
  if (suffix === "/maintenance/migrations" && req.method === "GET") return response(plans.filter((p) => p.row.workspace_id === workspaceId && p.row.link_id === row.id).map((p) => p.row));
  if (suffix === "/maintenance/migrations" && req.method === "POST") {
    if (!submission) return failure("link_maintenance_not_enabled");
    let input;
    try { input = projectMaintenanceCommit(body); } catch { return failure("invalid_input", 400); }
    const previous = plans.find((p) => p.row.link_id === row.id && p.key === input.idempotency_key);
    if (previous) return previous.request === JSON.stringify(input) ? response({ migration: previous.row, replayed: true }) : failure("link_maintenance_idempotency_conflict");
    if (plans.some((p) => p.row.link_id === row.id && p.row.status === "awaiting_executor")) return failure("link_maintenance_in_progress");
    if (input.expected_version !== row.desired_version || input.expected_generation !== row.generation) return failure("link_maintenance_state_conflict");
    const now = Date.now(), active = row.forwards.filter((f) => f.desired_status === "active").length;
    const plan: LinkMaintenanceMigration = { schema_version: 1, id: plans.length + 1, link_id: row.id, workspace_id: workspaceId, created_by: 1,
      operation: input.change.type, status: "awaiting_executor", state_version: 1, expected_version: row.desired_version, expected_generation: row.generation,
      candidate_config: input.change.type === "update_endpoints" ? input.change.config : row.config!, references: { total: row.forwards.length, active, suspended: row.forwards.length - active },
      created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(), hold_expires_at: new Date(now + 300000).toISOString(), reason_code: null,
      execution: { supported: false }, ports: { reserved: false, availability: "not_checked" } };
    plans.push({ row: plan, request: JSON.stringify(input), key: input.idempotency_key });
    return response({ migration: plan, replayed: false }, 201);
  }
  const cancel = /^\/maintenance\/migrations\/(\d+)\/cancel$/.exec(suffix);
  if (cancel && req.method === "POST") {
    const plan = plans.find((p) => p.row.id === Number(cancel[1]) && p.row.link_id === row.id && p.row.workspace_id === workspaceId)?.row;
    if (!plan) return failure("link_maintenance_not_found", 404);
    const expected = (body as { expected_state_version: number }).expected_state_version;
    if (plan.status === "cancelled" && [1, 2].includes(expected)) return response(plan);
    if (expected !== plan.state_version) return failure("link_maintenance_state_conflict");
    Object.assign(plan, { status: "cancelled", state_version: 2, reason_code: "link_maintenance_cancelled", updated_at: new Date().toISOString() });
    return response(plan);
  }
  if (!suffix && req.method === "GET") return response(row);
  if (suffix === "/maintenance/preview" && req.method === "POST") {
    const captured = { error: previewError, tamper: previewTamper, delay: previewDelay };
    let input;
    try { input = projectLinkMaintenanceInput(body); } catch { return failure("invalid_input", 400); }
    if (input.expected_version !== row.desired_version) return failure("link_version_conflict");
    if (input.expected_generation !== row.generation) return failure("link_generation_conflict");
    const result = maintenancePreview(row, input);
    result.submission = { supported: submission, hold_seconds: 300 };
    if (submission) result.snapshot.receipt = "lm1.Zml4dHVyZQ." + "a".repeat(64);
    result.expires_at = new Date(Date.parse(result.created_at) + previewLifetime).toISOString();
    if (captured.tamper === "workspace") result.workspace_id = 6;
    if (captured.tamper === "live") Object.assign(result.runtime, { tcp_connections: 0 });
    if (captured.tamper === "secret") Object.assign(result, { runner_config: { key: "NEVER_RENDER_THIS_SECRET" } });
    if (captured.delay) await Bun.sleep(1200);
    if (captured.error) return failure(captured.error, captured.error === "permission_denied" ? 403 : 409);
    return response(result);
  }
  if (req.method !== "GET" && plans.some((p) => p.row.link_id === row.id && p.row.status === "awaiting_executor")) return failure("link_maintenance_in_progress");
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
        if (f.client_source && !input.binding.client_source) return failure("link_client_source_required");
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
    ...(binding.client_source ? { client_source: projectLinkClientSource(binding.client_source) } : {}),
    bytes_per_second_out: binding.bytes_per_second_out, max_connections: binding.max_connections, max_connections_per_ip: binding.max_connections_per_ip };
}
function validateBinding(binding: LinkBindingInput): Response | null {
  if (sourceError) return failure(sourceError);
  if ((binding.client_source || binding.target_set?.strategy === "ip_hash") && binding.protocol !== "tcp") return failure("client_source_tcp_only", 400);
  if (binding.target_set?.strategy === "ip_hash" && !binding.client_source) return failure("ip_hash_requires_client_source", 400);
  if (binding.client_source) {
    try { projectLinkClientSource(binding.client_source); } catch { return failure("invalid_client_source", 400); }
  }
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
