/** Local fixture only. Bun already exists in the repo's test setup; no dependencies added. */
import { resolve } from "node:path";
import { nativeBothFixtureNodes, nativeBothFixtureRule } from "./forward-native-both-fixtures";
import { FORWARD_NATIVE_BOTH_CAPABILITY, nativeBothTransitionAllowed } from "@/lib/forward-native-both";
import type { ForwardPatchInput } from "@/lib/types";
const bundle = await Bun.build({ entrypoints: [resolve(import.meta.dir, "browser-native-both-entry.tsx")], target: "browser",
  define: { "process.env.NEXT_PUBLIC_API_MOCK": '"0"', "process.env.SERVER_API_BASE": '""', "process.env.NODE_ENV": '"development"' } });
if (!bundle.success) throw new Error(String(bundle.logs));
const js = await bundle.outputs[0].text();
let enabled = true, native = true, fresh = true, malformed = false, delay = false;
const calls: { path: string; method: string; workspaceId: number; body: unknown }[] = [];
const response = (data: unknown, status = 200) => Response.json({ data }, { status });
const fail = (code: string, status = 409) => Response.json({ code, error: code, details: { fixture: true } }, { status });
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>F4 native both fixture</title>
<style>:root{--background:#fff;--foreground:#111;--card:#fff;--border:#bbb;--muted:#eee;--muted-foreground:#444;--primary:#123;--primary-foreground:#fff;--destructive:#b00;--input:#aaa;--radius:8px}
body{font:14px system-ui;margin:16px}button,input{font:inherit;padding:7px;margin:4px}button:disabled{opacity:.4}[data-radix-popper-content-wrapper]{background:white;z-index:100!important}[role=dialog]{position:fixed;inset:3vh 8vw;background:white;border:1px solid #999;padding:16px;overflow:auto;z-index:50}[role=option]{padding:8px;cursor:pointer}[role=option][data-disabled]{opacity:.4}[role=alert]{color:#a00}main{max-width:1000px}</style>
</head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;
Bun.serve({ hostname: "127.0.0.1", port: 41974, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === "/") return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  if (path === "/bundle.js") return new Response(js, { headers: { "Content-Type": "text/javascript" } });
  if (path === "/__test/checks.js") return new Response(Bun.file(resolve(import.meta.dir, "browser-native-both-checks.js")), { headers: { "Content-Type": "text/javascript" } });
  if (path === "/favicon.ico") return new Response(null, { status: 204 });
  if (path === "/__test/state") return response({ calls });
  if (path === "/__test/scenario") {
    const input = await req.json() as Record<string, boolean>;
    enabled = input.enabled ?? enabled; native = input.native ?? native;
    fresh = input.fresh ?? fresh;
    malformed = input.malformed ?? malformed; delay = input.delay ?? delay;
    return response({ enabled, native, malformed, delay });
  }
  const workspaceId = Number(req.headers.get("x-workspace-id"));
  if (![5, 6].includes(workspaceId)) return fail("workspace_denied", 403);
  if (req.method !== "GET" && req.headers.get("X-CSRF-Token") !== "1") return fail("csrf_failed", 403);
  const body = req.method === "GET" ? null : await req.json();
  calls.push({ path, method: req.method, workspaceId, body });
  const snapshot = { enabled, native, fresh, malformed, workspaceId };
  if (delay) await Bun.sleep(1200);
  if (path === "/api/forwards/capabilities") return response(snapshot.malformed ? { native_both_enabled: "true" }
    : { native_both_enabled: snapshot.workspaceId === 5 && snapshot.enabled });
  if (path === "/api/nodes") return response(nativeBothFixtureNodes());
  const nodeMatch = /^\/api\/nodes\/(11|12)\/diagnostics$/.exec(path);
  if (nodeMatch) return response({ node_id: Number(nodeMatch[1]), reachability: snapshot.fresh ? "online" : "offline", panel: { reported: { capabilities: snapshot.native && snapshot.workspaceId === 5
    ? [FORWARD_NATIVE_BOTH_CAPABILITY] : ["forward.protocol.tcp.v1", "forward.protocol.udp.v1"] } } });
  if (path === "/api/forwards" && req.method === "POST") {
    if (body.protocol === "both" && (!enabled || !native || !fresh || malformed || workspaceId !== 5)) return fail("native_both_unavailable");
    return response(nativeBothFixtureRule({ ...body, id: 41, protocol: body.protocol, apply_status: "pending", applied_revision: null }), 201);
  }
  if (/^\/api\/forwards\/40(\/preview)?$/.test(path)) {
    const patch = body as ForwardPatchInput;
    // The edit fixture explicitly chooses its current protocol in each button.
    const rule = nativeBothFixtureRule();
    const candidate = { ...rule, ...patch };
    if (patch.protocol && !nativeBothTransitionAllowed(rule.protocol, patch.protocol)) return fail("unsupported_transition", 400);
    if (path.endsWith("/preview")) return response({ current: { revision: 7, config: rule, apply_status: "pending", desired_status: "active" },
      candidate: { revision: 8, config: candidate }, validation: { ok: true, errors: [], warnings: [], reasons: [] },
      impact: { metadata_only: Object.keys(patch).every((key) => key === "name"), runtime_change: true, target_change: "target_host" in patch,
        listener_replacement: "protocol" in patch || "target_host" in patch, mode_change: false, changes_external_address: false,
        nodes_prepare_drain: [], binding_required: false, port_status: "ok", desired_address: "127.0.0.1:25000" } });
    if (patch.expected_revision !== 7) return fail("revision_conflict");
    return response({ ...candidate, config_revision: 8, applied_revision: 6, latest_revision: 8, apply_status: "pending" });
  }
  return fail("route_not_found", 404);
} });
console.log("F4 browser fixture only http://127.0.0.1:41974");
