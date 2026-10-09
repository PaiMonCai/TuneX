import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError, setActiveWorkspace } from "@/lib/api/core";
import { linksApi, linkErrorInfo } from "@/lib/links-api";
import { isLinkMaintenancePreviewCurrent, LINK_MAINTENANCE_PORT_LIMIT, LINK_MAINTENANCE_REFERENCE_LIMIT,
  projectLinkMaintenanceInput, projectLinkMaintenancePreview } from "@/lib/link-maintenance-types";
import { LinksPayloadError } from "@/lib/links-types";
import { LinkDetailView } from "../link-detail";
import { LinkConfigForm } from "../link-forms";
import { LinkMaintenancePanel, LinkMaintenanceResult } from "../link-maintenance-preview";
import { linksCopy } from "../links-copy";
import { canEditLinkEndpoints, canRetireLink, createLinksScopeFence } from "../link-state";
import { forward, link } from "./links-fixtures";
import { maintenanceInput, maintenancePreview } from "./maintenance-fixtures";

const now = Date.parse("2029-01-01T00:00:00.000Z");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; setActiveWorkspace(null); });
function put(raw: unknown, path: string, value: unknown) {
  const keys = path.split("."); let obj = raw as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) obj = obj[key] as Record<string, unknown>;
  obj[keys.at(-1)!] = value;
}
function project(raw: unknown, input = maintenanceInput()) { return projectLinkMaintenancePreview(raw, 5, 3, input); }
describe("F5 bounded public maintenance projection", () => {
  test("projects exact public shape with desired suspended references and no live counts", () => {
    const row = link({ ref_count: 2, forwards: [forward(), forward({ id: 8, desired_status: "inactive" })] });
    const raw = maintenancePreview(row, maintenanceInput(row), now);
    expect(project(raw)).toEqual(raw);
    expect(project(raw).references).toMatchObject({ total: 2, active: 1, suspended: 1 });
    expect(project(raw).runtime).toMatchObject({ tcp_connections: null, udp_mappings: null });
  });
  test("secret extras are stripped recursively; nested projections are not aliases", () => {
    const raw = maintenancePreview();
    const inject = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(inject);
      else if (value && typeof value === "object") {
        Object.values(value).forEach(inject);
        Object.assign(value, { key: "DO_NOT_RENDER", runner_config: { key: "DO_NOT_RENDER" }, transport_key: "DO_NOT_RENDER" });
      }
    };
    inject(raw); const result = project(raw);
    expect(JSON.stringify(result)).not.toContain("DO_NOT_RENDER");
    raw.candidate.config.carrier_port = 1;
    expect(result.candidate.config.carrier_port).toBe(26002);
  });
  test("legal existing rule names with newline/tab roundtrip and remain escaped text", () => {
    const row = link({ forwards: [forward({ name: 'Queue\n\t<img src="x" onerror="bad()">' })] });
    const raw = maintenancePreview(row);
    expect(project(raw).references.forwards[0].name).toBe(row.forwards[0].name);
    const html = renderToStaticMarkup(<LinkMaintenanceResult preview={project(raw)} copy={linksCopy("en")} nodeLabel={String} />);
    expect(html).toContain("Queue\n\t&lt;img"); expect(html).not.toContain('<img src="x"');
  });
  test("500 refs and 2048 held ports are inclusive, oversized graphs reject without truncation", () => {
    const row = link({ ref_count: LINK_MAINTENANCE_REFERENCE_LIMIT, forwards: Array.from({ length: LINK_MAINTENANCE_REFERENCE_LIMIT }, (_, i) => forward({ id: i + 1, desired_status: i % 2 ? "inactive" : "active" })) });
    const raw = maintenancePreview(row);
    raw.ports.held = Array.from({ length: LINK_MAINTENANCE_PORT_LIMIT }, () => ({ ...raw.ports.held[0] }));
    expect(project(raw).references.total).toBe(500); expect(project(raw).ports.held).toHaveLength(2048);
    raw.ports.held.push(raw.ports.held[0]); expect(() => project(raw)).toThrow(LinksPayloadError); raw.ports.held.pop();
    raw.references.forwards.push(raw.references.forwards[0]); expect(() => project(raw)).toThrow(LinksPayloadError);
  });
  test.each([
    ["schema_version", 2], ["link_id", 4], ["workspace_id", 6], ["operation", "rotate_key"],
    ["snapshot.desired_version", 3], ["snapshot.generation", 5], ["snapshot.state_token", "x".repeat(64)],
    ["snapshot.state_token", "a".repeat(65)], ["candidate.config.ingress_node_id", 12], ["candidate.config.carrier_port", 65536],
    ["candidate.config.egress_node_id", 2_147_483_648], ["candidate.version", 4], ["candidate.generation", 6],
    ["candidate.key_action", "rotate"], ["changes.credentials_changed", true], ["changes.ingress_changed", "false"],
    ["references.total", 0], ["references.active", 0], ["references.suspended", 1], ["references.forwards.0.protocol", "tls"],
    ["references.forwards.0.desired_status", "suspended"], ["references.forwards.0.config_revision", -1],
    ["references.forwards.0.name", "x".repeat(256)], ["references.forwards.0.listener.bind_scope", "x".repeat(256)],
    ["references.forwards.0.candidate_listener.port", 1], ["references.forwards.0.candidate_listener.node_id", 15],
    ["runtime.tcp_connections", 0], ["runtime.udp_mappings", "0"], ["runtime.state", "not_deployed"],
    ["runtime.placements.0.ready", "true"], ["runtime.placements.0.role", "exit"], ["runtime.placements.0.state", "online"],
    ["ports.availability", "available"], ["ports.reserved", true], ["ports.held.0.port", 0], ["ports.candidate.0.protocol", "both"],
    ["execution.supported", true], ["execution.blockers", []], ["execution.blockers", ["maintenance_executor_unavailable", "key=leak"]],
    ["execution.stages", ["cutover_ingress"]], ["impact.listener_move", true], ["impact.tcp", "online"], ["impact.udp", "preserved"],
    ["created_at", "2029-02-30T00:00:00.000Z"], ["expires_at", "2029-01-01T00:01:00.001Z"],
    ["expires_at", "2029-01-01T00:00:00.000Z"], ["expires_at", "not-a-date"],
  ])("reject malformed %s", (path, value) => {
    const raw = maintenancePreview(link(), maintenanceInput(), now); put(raw, path as string, value);
    expect(() => project(raw)).toThrow(LinksPayloadError);
  });
  test("duplicate references/roles, excess placements/ports and missing objects fail closed", () => {
    const cases = [null, [], {}, { ...maintenancePreview(), candidate: null }];
    cases.forEach((raw) => expect(() => project(raw)).toThrow(LinksPayloadError));
    let raw = maintenancePreview(); raw.references.forwards.push(raw.references.forwards[0]); raw.references.total = raw.references.active = 2;
    expect(() => project(raw)).toThrow(LinksPayloadError);
    raw = maintenancePreview(); raw.runtime.placements[1] = raw.runtime.placements[0]; expect(() => project(raw)).toThrow(LinksPayloadError);
    raw = maintenancePreview(); raw.runtime.placements.push(raw.runtime.placements[0]); expect(() => project(raw)).toThrow(LinksPayloadError);
    raw = maintenancePreview(); raw.ports.candidate = Array(2049).fill(raw.ports.candidate[0]); expect(() => project(raw)).toThrow(LinksPayloadError);
  });
  test("no-change and undeployed rotation retain executor blockers and candidate numbering", () => {
    const row = link({ generation: 0, deployment: null, forwards: [], ref_count: 0 });
    const input = maintenanceInput(row, "update_endpoints", row.config!);
    expect(project(maintenancePreview(row, input), input).execution.blockers).toEqual(["maintenance_executor_unavailable", "link_no_change"]);
    const rotate = maintenanceInput(row, "rotate_key");
    const result = project(maintenancePreview(row, rotate), rotate);
    expect(result.candidate).toMatchObject({ version: 2, generation: 1, key_action: "rotate" });
    expect(result.execution.blockers).toEqual(["maintenance_executor_unavailable", "link_not_deployed"]);
  });
  test("conservative deployed-suspension and unknown-runtime impacts are not derived from desired active counts", () => {
    const row = link({ forwards: [forward({ desired_status: "inactive", forward_protocol: "udp" })] });
    const raw = maintenancePreview(row);
    expect(raw.references.active).toBe(0);
    expect(project(raw).impact).toMatchObject({ tcp: "drain_required", udp: "mapping_rebuild_required" });
    // A Ready deployed snapshot may still carry a recently desired-suspended binding.
    raw.runtime.state = "ready"; raw.execution.blockers = ["maintenance_executor_unavailable"];
    expect(project(raw).impact).toEqual(raw.impact);
  });
});

describe("F5 strict request and shared API", () => {
  test("request numeric limits match backend and do not carry config/key extras", () => {
    const input = { expected_version: 2_147_483_646, expected_generation: 2_147_483_646, change: { type: "rotate_key" } };
    expect(projectLinkMaintenanceInput(input)).toEqual(input);
    for (const [path, value] of [["expected_version", 0], ["expected_version", 2_147_483_647], ["expected_generation", -1],
      ["expected_generation", 1.5], ["expected_generation", "4"], ["change.config.carrier_port", 0], ["change.config.carrier_port", 65536],
      ["change.config.ingress_node_id", 12], ["change.config.egress_node_id", NaN], ["change.type", "execute"]] as const) {
      const raw = maintenanceInput(); put(raw, path, value); expect(() => projectLinkMaintenanceInput(raw)).toThrow(LinksPayloadError);
    }
    expect(() => projectLinkMaintenanceInput({ ...input, state_token: "a".repeat(64) })).toThrow(LinksPayloadError);
    expect(() => projectLinkMaintenanceInput({ ...input, change: { type: "rotate_key", key: "never-send" } })).toThrow(LinksPayloadError);
    const raw = maintenanceInput(); if (raw.change.type === "update_endpoints") Object.assign(raw.change.config, { key: "never-send" });
    expect(() => projectLinkMaintenanceInput(raw)).toThrow(LinksPayloadError);
  });
  test("POST unwraps shared {data}, scopes workspace, retains CSRF/session/CAS and never calls execution", async () => {
    setActiveWorkspace(99);
    const paths: string[] = [];
    globalThis.fetch = (async (url, init) => {
      paths.push(String(url).split("/api")[1]);
      expect(init?.method).toBe("POST"); expect(init?.cache).toBe("no-store"); expect(init?.credentials).toBe("include");
      expect(init?.headers).toMatchObject({ "x-workspace-id": "5", "X-CSRF-Token": "1" });
      const input = JSON.parse(String(init?.body));
      expect(input).toEqual(maintenanceInput(link(), input.change.type));
      return Response.json({ data: { ...maintenancePreview(link(), input), key: "never-visible" } });
    }) as typeof fetch;
    for (const operation of ["update_endpoints", "rotate_key"] as const) {
      const result = await linksApi.previewMaintenance(5, 3, maintenanceInput(link(), operation));
      expect(result.operation).toBe(operation); expect(JSON.stringify(result)).not.toContain("never-visible");
    }
    expect(paths).toEqual(["/links/3/maintenance/preview", "/links/3/maintenance/preview"]);
  });
  test("HTTP success with wrong tenant, operation, requested config or CAS is not a usable preview", async () => {
    for (const [path, value] of [["link_id", 4], ["workspace_id", 6], ["operation", "rotate_key"], ["snapshot.desired_version", 3],
      ["snapshot.generation", 5], ["candidate.config.carrier_port", 26003]] as const) {
      globalThis.fetch = (async () => { const raw = maintenancePreview(); put(raw, path, value); return Response.json({ data: raw }); }) as typeof fetch;
      await expect(linksApi.previewMaintenance(5, 3, maintenanceInput())).rejects.toThrow(LinksPayloadError);
    }
  });
  test("invalid path identity and strict inputs fail before any HTTP", async () => {
    let calls = 0; globalThis.fetch = (async () => { calls++; return Response.json({}); }) as typeof fetch;
    for (const id of [0, -1, 1.5, NaN, 2_147_483_648]) await expect(linksApi.previewMaintenance(5, id, maintenanceInput())).rejects.toThrow();
    await expect(linksApi.previewMaintenance(0, 3, maintenanceInput())).rejects.toThrow();
    await expect(linksApi.previewMaintenance(5, 3, { ...maintenanceInput(), expected_version: 0 })).rejects.toThrow();
    expect(calls).toBe(0);
  });
  test("safe feature/denied/version/generation/too-large failures never fabricate results", async () => {
    for (const code of ["fxp_links_not_enabled", "permission_denied", "link_version_conflict", "link_generation_conflict", "link_maintenance_preview_too_large"]) {
      globalThis.fetch = (async () => Response.json({ code, error: "private runner config" }, { status: code === "permission_denied" ? 403 : 409 })) as typeof fetch;
      let failure: unknown; try { await linksApi.previewMaintenance(5, 3, maintenanceInput()); } catch (e) { failure = e; }
      expect(failure).toBeInstanceOf(ApiError); expect(linkErrorInfo(failure).code).toBe(code);
      if (code.endsWith("conflict")) expect(linkErrorInfo(failure).conflict).toBe(true);
    }
  });
});

describe("F5 stale/read-only UI and scope fences", () => {
  test("expiry, clock skew, link/workspace/CAS/revision/status/reference/config/lease changes invalidate", () => {
    const row = link(), result = maintenancePreview(row, maintenanceInput(row), now);
    expect(isLinkMaintenancePreviewCurrent(result, row, now)).toBe(true);
    expect(isLinkMaintenancePreviewCurrent(result, row, now + 59_999)).toBe(true);
    for (const time of [now + 60_000, now - 5_001, NaN]) expect(isLinkMaintenancePreviewCurrent(result, row, time)).toBe(false);
    for (const [path, value] of [["workspace_id", 6], ["id", 4], ["desired_version", 3], ["generation", 5], ["status", "retiring"],
      ["ref_count", 2], ["forwards", []], ["forwards.0.config_revision", 9], ["forwards.0.desired_status", "inactive"],
      ["forwards.0.forward_protocol", "udp"], ["forwards.0.listen_port", 1234], ["forwards.0.listen_ip", "127.0.0.1"],
      ["config.carrier_port", 26002], ["config", null]] as const) {
      const changed = link(); put(changed, path, value); expect(isLinkMaintenancePreviewCurrent(result, changed, now)).toBe(false);
    }
    row.deployment!.lease_expires_at = new Date(now + 1).toISOString();
    expect(isLinkMaintenancePreviewCurrent(result, row, now + 1)).toBe(false);
  });
  test("preview tickets fence only preview/read/scope, never invalidate unrelated write tickets", () => {
    const fence = createLinksScopeFence(); fence.setScope("5:manage");
    const read = fence.next("read"), mutation = fence.next("mutation"), preview = fence.next("preview");
    fence.next("preview"); expect(fence.current(preview)).toBe(false); expect(fence.current(mutation)).toBe(true);
    const fresh = fence.next("preview"); fence.next("read"); expect(fence.current(read)).toBe(false); expect(fence.current(fresh)).toBe(true);
    fence.setScope("6:read"); expect(fence.current(fresh)).toBe(false); expect(fence.current(mutation)).toBe(false);
  });
  test("optional preview callback does not relax live endpoint/rotation guards or node:manage", () => {
    const row = link(); expect(canEditLinkEndpoints(row)).toBe(false); expect(canRetireLink(row)).toBe(false);
    const noop = () => {};
    for (const locale of ["en", "zh"] as const) {
      const copy = linksCopy(locale);
      const render = (manage: boolean, callback?: () => void, busy = false) => renderToStaticMarkup(<LinkDetailView link={row} copy={copy} canManage={manage} busy={busy} now={now}
        nodeLabel={String} onEdit={noop} onDeploy={noop} onRotate={noop} onRetire={noop} onAdd={noop} onEditForward={noop} onAction={noop} onPreview={callback} />);
      expect(render(false, noop)).not.toContain(copy.maintenancePreview); expect(render(true)).not.toContain(copy.maintenancePreview);
      const html = render(true, noop);
      expect(html).toContain(copy.maintenancePreview);
      const buttons = html.match(/<button[^>]*>.*?<\/button>/g)!;
      for (const label of [copy.edit, copy.rotate]) expect(buttons.find((b) => b.includes(`>${label}<`))).toContain(' disabled=""');
      expect(buttons.find((b) => b.includes(`>${copy.maintenancePreview}<`))).not.toContain(' disabled=""');
      expect(render(true, noop, true).match(/<button[^>]*>.*?<\/button>/g)!.find((b) => b.includes(`>${copy.maintenancePreview}<`))).toContain(' disabled=""');
    }
  });
  test("bilingual results are planning only, desired counts, unknown live counts, unreserved/unchecked ports; no execution button or token", () => {
    for (const locale of ["en", "zh"] as const) {
      const copy = linksCopy(locale), raw = maintenancePreview();
      const html = renderToStaticMarkup(<LinkMaintenanceResult preview={raw} copy={copy} nodeLabel={String} />);
      for (const label of [copy.previewNoExecutor, copy.previewPortHint, copy.previewLiveUnknown, copy.previewActive, copy.previewSuspended, copy.previewStages, copy.previewPendingHint]) expect(html).toContain(label);
      expect(html).not.toContain("<button"); expect(html).not.toContain(raw.snapshot.state_token); expect(html).not.toContain(copy.submitted); expect(html).not.toContain(copy.configSaved);
      const form = renderToStaticMarkup(<LinkConfigForm copy={copy} initial={link().config!} nodes={[]} nodesError={false} busy={false}
        submitLabel={copy.previewRun} ariaLabel={copy.previewEndpoints} onCancel={() => {}} onSubmit={async () => {}} />);
      expect(form).toContain(copy.previewRun); expect(form).toContain(`aria-label="${copy.previewEndpoints}"`); expect(form).not.toContain(`>${copy.save}<`);
      const panel = renderToStaticMarkup(<LinkMaintenancePanel link={link()} copy={copy} nodes={[]} nodesError={false} busy={false} now={now}
        nodeLabel={String} onClose={() => {}} onPreview={async () => null} />);
      expect(panel).toContain(copy.previewHint); expect(panel).not.toContain(copy.submitted); expect(copy.previewTooLarge).toContain("500");
    }
  });
});
