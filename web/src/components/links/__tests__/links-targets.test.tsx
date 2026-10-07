import { afterEach, describe, expect, test } from "bun:test";
import { isIP } from "node:net";
import { renderToStaticMarkup } from "react-dom/server";
import { isLinkTargetHost, projectLinkDetail, projectLinkTargetSet, LinksPayloadError, type LinkDetail } from "@/lib/links-types";
import { ApiError } from "@/lib/api/core";
import { linksApi, linkErrorInfo } from "@/lib/links-api";
import { LinkBindingForm, parseLinkBindingForm } from "../link-forms";
import { LinkDetailView } from "../link-detail";
import { ForwardTargets } from "../link-target-details";
import { bindingFromForward, forwardTargetStatus, linkErrorMessage, linkLiveState } from "../link-state";
import { linksCopy } from "../links-copy";
import { binding, forward, link, targetSet, targetStatus, targetLink } from "./links-fixtures";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const noop = () => {};
const now = Date.parse("2029-01-01T00:00:00Z");
const exit = (row: LinkDetail) => row.deployment!.placements[1];
function data(multiple = true) {
  const result = new FormData();
  for (const [key, value] of Object.entries(binding)) result.set(key, String(value));
  if (multiple) {
    result.set("target_set_enabled", "1"); result.append("target_host", "127.0.0.2"); result.append("target_port", "25002");
    result.set("target_strategy", "round_robin"); result.set("target_probe", "tcp");
    result.set("target_failure_seconds", "10"); result.set("target_recover_seconds", "3600");
  }
  return result;
}
function targetsMarkup(row = targetLink(), locale: "zh" | "en" = "en", time = now) {
  return renderToStaticMarkup(<ForwardTargets link={row} forward={row.forwards[0]} copy={linksCopy(locale)} now={time} />);
}

describe("F2 target set closed bounded contract", () => {
  test("absent fields preserve legacy from remote, no fabricated set or health", () => {
    const row = projectLinkDetail(link(), 5);
    expect(row.forwards[0]).not.toHaveProperty("target_set");
    expect(bindingFromForward(row.forwards[0])).toEqual(binding);
    expect(forwardTargetStatus(row, row.forwards[0], now)).toBeNull();
    expect(targetsMarkup(row)).toContain("Legacy single target");
    expect(targetsMarkup(row)).toContain("127.0.0.1:25001");
    expect(targetsMarkup(row)).not.toContain(">Healthy<");
  });
  test("one and ten targets, all strategies and probes and inclusive windows retain order", () => {
    for (const count of [1, 10]) for (const strategy of ["fallback", "round_robin", "random"] as const) {
      for (const probe of ["tcp", "none"] as const) {
        const set = targetSet({ targets: Array.from({ length: count }, (_, i) => ({ host: `target-${i}.internal`, port: i + 1 })),
          strategy, probe, failure_seconds: 10, recover_seconds: 3600 });
        expect(projectLinkTargetSet(set)).toEqual(set);
      }
    }
  });
  test("unknown keys at set, target and observation level never enter UI state", () => {
    const row = targetLink();
    const raw = { ...row, forwards: [{ ...row.forwards[0], target_set: { ...targetSet(), key: "never-visible", targets: targetSet().targets.map((t) => ({ ...t, credential: "never-visible" })) } }],
      deployment: { ...row.deployment, placements: [row.deployment!.placements[0], { ...exit(row), observation: { ...exit(row).observation,
        digest: "never-visible", target_status: [{ ...targetStatus(), sessions: "never-visible", key: "never-visible" }] } }] } };
    const result = projectLinkDetail(raw, 5);
    expect(result.forwards[0].target_set).toEqual(targetSet());
    expect(exit(result).observation!.target_status).toEqual([targetStatus()]);
    expect(JSON.stringify(result)).not.toContain("never-visible");
    expect(targetsMarkup(result)).not.toContain("never-visible");
    expect(result.forwards[0].target_set).not.toBe(raw.forwards[0].target_set);
  });
  test("present sets require every field; null is not an absent legacy set", () => {
    for (const value of [null, false, 0, "{}", [], {}]) expect(() => projectLinkTargetSet(value)).toThrow(LinksPayloadError);
    for (const field of Object.keys(targetSet())) {
      const raw: Record<string, unknown> = { ...targetSet() }; delete raw[field];
      expect(() => projectLinkTargetSet(raw)).toThrow(LinksPayloadError);
    }
    expect(() => projectLinkDetail(link({ forwards: [{ ...forward(), target_set: null } as never] }), 5)).toThrow(LinksPayloadError);
  });
  test("strict enum and bounded integer fields reject coercion and overflow", () => {
    for (const field of ["failure_seconds", "recover_seconds"]) for (const value of [undefined, null, true, "30", 9, 3601, 10.1, NaN, Infinity]) {
      expect(() => projectLinkTargetSet({ ...targetSet(), [field]: value })).toThrow(LinksPayloadError);
    }
    for (const version of [0, 2, "1", true]) expect(() => projectLinkTargetSet({ ...targetSet(), version })).toThrow(LinksPayloadError);
    for (const strategy of ["Fallback", "round-robin", "random\n", null]) expect(() => projectLinkTargetSet({ ...targetSet(), strategy })).toThrow(LinksPayloadError);
    for (const probe of ["udp", "TCP", false, null]) expect(() => projectLinkTargetSet({ ...targetSet(), probe })).toThrow(LinksPayloadError);
  });
  test("addresses, ports, cardinality and case-insensitive duplicate pairs are checked", () => {
    for (const host of ["", " ", " x", "a/b", "a b", "a\u0000b", "a\u0001b", "a".repeat(256)]) {
      expect(() => projectLinkTargetSet(targetSet({ targets: [{ host, port: 80 }] }))).toThrow(LinksPayloadError);
    }
    for (const port of [0, 65536, 1.5, "80", null, true, Infinity]) {
      expect(() => projectLinkTargetSet({ ...targetSet(), targets: [{ host: "::1", port }] })).toThrow(LinksPayloadError);
    }
    for (const targets of [[], Array(11).fill({ host: "a", port: 80 }), [{ host: "HOST", port: 80 }, { host: "host", port: 80 }]]) {
      expect(() => projectLinkTargetSet({ ...targetSet(), targets })).toThrow(LinksPayloadError);
    }
    expect(projectLinkTargetSet(targetSet({ targets: [{ host: "host", port: 80 }, { host: "HOST", port: 81 }] })).targets).toHaveLength(2);
  });
  test("first remote fields must match the set; editing clones all items and options", () => {
    const row = targetLink();
    expect(() => projectLinkDetail({ ...row, forwards: [{ ...row.forwards[0], remote_port: 9999 }] }, 5)).toThrow(LinksPayloadError);
    expect(() => projectLinkDetail({ ...row, forwards: [{ ...row.forwards[0], remote_host: "wrong.internal" }] }, 5)).toThrow(LinksPayloadError);
    const input = bindingFromForward(row.forwards[0]);
    expect(input.target_set).toEqual(targetSet()); expect(input.target_host).toBe(input.target_set!.targets[0].host);
    input.target_set!.targets[1].host = "changed.internal";
    expect(row.forwards[0].target_set!.targets[1].host).toBe("127.0.0.2");
  });
  test("raw IPv6 agrees with node:net; backslashes, brackets, ports and invalid colons are rejected", () => {
    const colonHosts = ["::", "::1", "2001:db8::1", "2001:DB8:0:0:0:0:2:1", "::ffff:192.0.2.1", "2001:db8:0:0:0:192.0.2.1", "0:0:0:0:0:ffff:192.0.2.128",
      "host:443", "127.0.0.1:80", "2001:db8:::1", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7", "::gg", "::1%lo", "::ffff:192.0.2.999", "::ffff:192.00.2.1", "[::1]", "[::1]:443", "http://www.example.com"];
    for (const host of colonHosts) {
      // Node accepts zone IDs, while Go net.ParseIP and raw target contracts do not.
      const valid = isIP(host) === 6 && !host.includes("%");
      expect(isLinkTargetHost(host)).toBe(valid);
      if (!valid) {
        expect(() => projectLinkTargetSet(targetSet({ targets: [{ host, port: 443 }] }))).toThrow(LinksPayloadError);
        const form = data(); form.set("target_host", host); form.set("target_port", "443"); expect(() => parseLinkBindingForm(form)).toThrow();
      }
    }
    for (const host of ["server\\path", "www.example.com\\", "www.example.com:443", "[2001:db8::1]"]) {
      expect(isLinkTargetHost(host)).toBe(false); expect(() => projectLinkTargetSet(targetSet({ targets: [{ host, port: 443 }] }))).toThrow(LinksPayloadError);
    }
    for (const host of ["www.example.com", "localhost", "127.0.0.1", "2001:db8::1"]) {
      expect(projectLinkTargetSet(targetSet({ targets: [{ host, port: 443 }] })).targets[0]).toEqual({ host, port: 443 });
    }
  });
});

describe("F2 per-generation target observations", () => {
  function project(value: unknown) {
    const row = targetLink(); (exit(row).observation as Record<string, unknown>).target_status = value;
    return exit(projectLinkDetail(row, 5)).observation!;
  }
  test("optional status stays absent; empty arrays and initial null selections preserve unknown", () => {
    expect(project(undefined)).not.toHaveProperty("target_status");
    expect(project([]).target_status).toEqual([]);
    const initial = targetStatus({ states: ["unknown", "unknown"], selected_tcp: null, selected_udp: null, last_checked_at: null, reason: "initial" });
    expect(project([initial]).target_status).toEqual([initial]);
  });
  test("all states and reasons remain exact, including unhealthy with Ready true", () => {
    for (const state of ["unknown", "healthy", "suspect", "recovering", "unhealthy"] as const) {
      for (const reason of ["initial", "selected", "target_failed", "target_recovered", "all_unavailable"] as const) {
        const status = targetStatus({ states: [state], selected_udp: null, reason });
        expect(project([status]).target_status).toEqual([status]); expect(project([status]).ready).toBe(true);
      }
    }
  });
  test("malformed, incomplete, duplicate or unbounded observations are rejected", () => {
    for (const value of [null, false, {}, "[]", Array(501).fill(targetStatus()), [targetStatus(), targetStatus()]]) {
      expect(() => project(value)).toThrow(LinksPayloadError);
    }
    for (const field of Object.keys(targetStatus())) {
      const status: Record<string, unknown> = { ...targetStatus() }; delete status[field];
      expect(() => project([status])).toThrow(LinksPayloadError);
    }
    for (const states of [[], Array(11).fill("healthy"), ["ready"], [null], ["Healthy"]]) {
      expect(() => project([{ ...targetStatus(), states }])).toThrow(LinksPayloadError);
    }
    for (const field of ["selected_tcp", "selected_udp"]) for (const value of [-1, 2, 0.5, "0", true, undefined]) {
      expect(() => project([{ ...targetStatus(), [field]: value }])).toThrow(LinksPayloadError);
    }
    for (const forward_id of [0, -1, 2147483648, 1.5, "7"]) expect(() => project([{ ...targetStatus(), forward_id }])).toThrow(LinksPayloadError);
    for (const reason of ["healthy", null, "selected\n"]) expect(() => project([{ ...targetStatus(), reason }])).toThrow(LinksPayloadError);
  });
  test("timestamps require valid instants, never normalized impossible dates", () => {
    for (const last_checked_at of ["", "2029-02-30T00:00:00Z", "2029-01-01T24:00:00Z", "2029-01-01T00:00:00", 0, undefined]) {
      expect(() => project([{ ...targetStatus(), last_checked_at }])).toThrow(LinksPayloadError);
    }
    expect(project([targetStatus({ last_checked_at: "2028-02-29T08:00:00+08:00" })]).target_status![0].last_checked_at).toBe("2028-02-29T08:00:00+08:00");
  });
  test("only exit observations supply per-index health and last selection in both languages", () => {
    for (const locale of ["zh", "en"] as const) {
      const row = targetLink(); const copy = linksCopy(locale);
      row.deployment!.placements[0].observation!.target_status = [targetStatus({ states: ["unhealthy", "unhealthy"] })];
      const html = targetsMarkup(row, locale);
      expect(html).toContain(copy.healthHealthy); expect(html).toContain(copy.healthSuspect);
      expect(html).not.toContain(`>${copy.healthUnhealthy}<`);
      expect(html).toContain(`${copy.targetIndex} 0`); expect(html).toContain(`${copy.targetIndex} 1`);
      expect(html).toContain(targetStatus().last_checked_at!); expect(html).toContain(copy.reasonTargetFailed);
      expect(html).toContain(renderToStaticMarkup(<>{copy.targetHealthHint}</>)); expect(html).toContain(copy.udpProbeHint);
      delete exit(row).observation!.target_status;
      expect(forwardTargetStatus(row, row.forwards[0], now)).toBeNull();
      expect(targetsMarkup(row, locale)).not.toContain(`>${copy.healthHealthy}<`);
    }
  });
  test("all unavailable never turns a ready exit off, and health never restores a failed exit's Ready", () => {
    const row = targetLink(); exit(row).observation!.target_status = [targetStatus({ states: ["unhealthy", "unhealthy"], reason: "all_unavailable" })];
    expect(linkLiveState(row, exit(row), now)).toBe("ready");
    expect(targetsMarkup(row)).toContain("All targets unavailable"); expect(targetsMarkup(row)).toContain("Unhealthy");
    exit(row).observation!.state = "failed"; exit(row).observation!.ready = false;
    expect(targetsMarkup(row)).not.toContain(">Unhealthy<");
    expect(forwardTargetStatus(row, row.forwards[0], now)).toBeNull();
    expect(linkLiveState(row, exit(row), now)).toBe("failed");
    delete exit(row).observation!.target_status;
    expect(targetsMarkup(row)).not.toContain(">Unhealthy<");
  });
  test("projected cached target facts expire after 60 seconds while runtime lease and Ready remain valid", () => {
    const row = projectLinkDetail(targetLink(), 5);
    for (const age of [59_999, 60_000]) {
      expect(forwardTargetStatus(row, row.forwards[0], now + age)).toEqual(targetStatus());
      expect(targetsMarkup(row, "en", now + age)).toContain(">Healthy<");
    }
    for (const age of [60_001, 120_000]) for (const locale of ["zh", "en"] as const) {
      const copy = linksCopy(locale); const html = targetsMarkup(row, locale, now + age);
      expect(forwardTargetStatus(row, row.forwards[0], now + age)).toBeNull();
      expect(html).not.toContain(`>${copy.healthHealthy}<`); expect(html).not.toContain(targetStatus().last_checked_at!);
      expect(html).not.toContain(`>${copy.reasonTargetFailed}<`); expect(html).toContain(copy.targetUnknownHint);
      expect(html).toMatch(new RegExp(`${copy.targetLastUdp}</dt><dd[^>]*>${copy.unknown}</dd>`));
      expect(linkLiveState(row, exit(row), now + age)).toBe("ready");
    }
  });
  test("projected target timestamps allow up to five seconds future skew; larger skew remains unknown", () => {
    for (const skew of [4_999, 5_000, 5_001, 60_000]) {
      const row = targetLink(); exit(row).observation!.target_status![0].last_checked_at = new Date(now + skew).toISOString();
      const projected = projectLinkDetail(row, 5);
      expect(exit(projected).observation!.target_status![0].last_checked_at).toBe(new Date(now + skew).toISOString());
      expect(forwardTargetStatus(projected, projected.forwards[0], now) !== null).toBe(skew <= 5_000);
      expect(targetsMarkup(projected).includes(">Healthy<")).toBe(skew <= 5_000);
      expect(linkLiveState(projected, exit(projected), now)).toBe("ready");
    }
  });
  test("nullable timestamps retain unknown initial projection but cannot establish known health", () => {
    const row = targetLink();
    const initial = targetStatus({ states: ["unknown", "unknown"], selected_tcp: null, selected_udp: null, last_checked_at: null, reason: "initial" });
    exit(row).observation!.target_status = [initial];
    const projected = projectLinkDetail(row, 5);
    expect(exit(projected).observation!.target_status).toEqual([initial]);
    expect(forwardTargetStatus(projected, projected.forwards[0], now + 120_000)).toEqual(initial);
    expect(targetsMarkup(projected)).toContain(">Initial state<"); expect(targetsMarkup(projected)).not.toContain(">Healthy<");
    exit(row).observation!.target_status![0].states[0] = "healthy";
    expect(forwardTargetStatus(projectLinkDetail(row, 5), row.forwards[0], now)).toBeNull();
    expect(targetsMarkup(projectLinkDetail(row, 5))).not.toContain(">Healthy<");
    for (const ready of [false, null]) {
      exit(row).observation!.ready = ready;
      expect(forwardTargetStatus(projectLinkDetail(row, 5), row.forwards[0], now)).toBeNull();
      expect(linkLiveState(row, exit(row), now)).toBe("unknown");
    }
  });
  test("stale, digest-stripped, mismatched, unapplied and expired facts all display unknown", () => {
    const cases: LinkDetail[] = [];
    for (const state of ["stale", "mismatch", "unknown", "absent", "expired", "closed", "removed", "unrecognized_runtime"]) {
      const row = targetLink(); exit(row).observation!.state = state; cases.push(row);
    }
    for (const mutate of [
      (row: LinkDetail) => { delete exit(row).observation!.target_status; },
      (row: LinkDetail) => { exit(row).observation!.observed_generation = 3; },
      (row: LinkDetail) => { exit(row).generation = 3; },
      (row: LinkDetail) => { row.deployment!.generation = 3; },
      (row: LinkDetail) => { row.generation = 5; },
      (row: LinkDetail) => { row.deployment!.lease_expires_at = new Date(now).toISOString(); },
      (row: LinkDetail) => { row.deployment!.lease_expires_at = "invalid"; },
      (row: LinkDetail) => { row.forwards[0].config_revision++; },
      (row: LinkDetail) => { row.status = "retired"; },
      (row: LinkDetail) => { row.status = "retiring"; },
      (row: LinkDetail) => { exit(row).node_id = 999; },
      (row: LinkDetail) => { exit(row).observation!.target_status = [targetStatus({ forward_id: 99 })]; },
      (row: LinkDetail) => { exit(row).observation!.target_status = [targetStatus({ states: ["healthy"], selected_udp: null })]; },
    ]) { const row = targetLink(); mutate(row); cases.push(row); }
    for (const row of cases) {
      expect(forwardTargetStatus(row, row.forwards[0], now)).toBeNull();
      const html = targetsMarkup(row); expect(html).not.toContain(">Healthy<"); expect(html).not.toContain(targetStatus().last_checked_at!);
      expect(html).toContain(linksCopy("en").targetUnknownHint);
    }
    expect(targetsMarkup(targetLink(), "en", Date.parse("2031-01-01Z"))).not.toContain(">Healthy<");
  });
  test("probe none keeps silence unknown and displays fresh passive TCP or UDP health without overriding observation gates", () => {
    for (const forward_protocol of ["tcp", "udp", "both"] as const) for (const locale of ["zh", "en"] as const) {
      const copy = linksCopy(locale);
      const row = targetLink(); row.forwards[0].target_set!.probe = "none"; row.forwards[0].forward_protocol = forward_protocol;
      exit(row).observation!.target_status = [targetStatus({ states: ["unknown", "unknown"], selected_tcp: null, selected_udp: null,
        last_checked_at: null, reason: "initial" })];
      const silent = projectLinkDetail(row, 5);
      const html = targetsMarkup(silent, locale);
      expect(html).not.toContain(`>${copy.healthHealthy}<`); expect(html).not.toContain(`>${copy.healthUnhealthy}<`);
      expect(html).toContain(copy.probeNone); expect(html).toContain(copy.targetProbeHint);
      expect(forwardTargetStatus(silent, silent.forwards[0], now)!.states).toEqual(["unknown", "unknown"]);
      if (forward_protocol !== "tcp") expect(html).toContain(copy.udpProbeHint);

      // Actual TCP dial results or a UDP reply are passive evidence with none configured.
      for (const state of ["healthy", "suspect", "recovering", "unhealthy"] as const) {
        const labels = { healthy: copy.healthHealthy, suspect: copy.healthSuspect, recovering: copy.healthRecovering, unhealthy: copy.healthUnhealthy };
        exit(row).observation!.target_status = [targetStatus({ states: [state, state], reason: "selected" })];
        const fresh = projectLinkDetail(row, 5);
        expect(targetsMarkup(fresh, locale)).toContain(`>${labels[state]}<`);
        expect(forwardTargetStatus(fresh, fresh.forwards[0], now)!.states).toEqual([state, state]);
        expect(linkLiveState(fresh, exit(fresh), now)).toBe("ready");
        expect(targetsMarkup(fresh, locale, now + 60_001)).not.toContain(`>${labels[state]}<`);
      }
      exit(row).observation!.target_status = [targetStatus({ states: ["healthy", "healthy"], reason: "selected" })];
      exit(row).observation!.ready = false;
      expect(targetsMarkup(projectLinkDetail(row, 5), locale)).not.toContain(`>${copy.healthHealthy}<`);
      expect(linkLiveState(row, exit(row), now)).toBe("unknown");
    }
  });
});

describe("F2 production forms and transport", () => {
  test("legacy remains opt-in and a reordered first item is written to required first fields", () => {
    expect(parseLinkBindingForm(data(false))).toEqual(binding);
    const input = data(); input.delete("target_host"); input.delete("target_port");
    for (const target of [...targetSet().targets].reverse()) { input.append("target_host", target.host); input.append("target_port", String(target.port)); }
    const result = parseLinkBindingForm(input);
    expect(result.target_set!.targets).toEqual([...targetSet().targets].reverse());
    expect(result.target_host).toBe("127.0.0.2"); expect(result.target_port).toBe(25002);
    const html = renderToStaticMarkup(<LinkBindingForm copy={linksCopy("en")} busy={false} onCancel={noop} onSubmit={async () => {}} />);
    expect(html).toMatch(/name="target_set_enabled"[^>]*value="1"/); expect(html).not.toContain('name="target_strategy"');
    expect(html).not.toContain('name="target_failure_seconds"');
  });
  test("explicit one-item set, duplicate pairs and unmatched or excessive arrays have correct boundaries", () => {
    const input = data(); input.delete("target_host"); input.delete("target_port");
    input.set("target_host", " ::1 "); input.set("target_port", "65535");
    expect(parseLinkBindingForm(input).target_set!.targets).toEqual([{ host: "::1", port: 65535 }]);
    const missing = data(); missing.delete("target_port"); expect(() => parseLinkBindingForm(missing)).toThrow();
    const duplicate = data(); duplicate.delete("target_host"); duplicate.delete("target_port");
    duplicate.append("target_host", "Host.internal"); duplicate.append("target_port", "80"); duplicate.append("target_host", "host.internal"); duplicate.append("target_port", "80");
    expect(() => parseLinkBindingForm(duplicate)).toThrow();
    const excess = data(); for (let i = 0; i < 9; i++) { excess.append("target_host", `target-${i}.internal`); excess.append("target_port", "80"); }
    expect(() => parseLinkBindingForm(excess)).toThrow();
    const legacy = data(); legacy.delete("target_set_enabled"); expect(() => parseLinkBindingForm(legacy)).toThrow();
    for (const value of ["9", "3601", "1.5", "-1", "", "1e2"]) {
      const invalid = data(); invalid.set("target_failure_seconds", value); expect(() => parseLinkBindingForm(invalid)).toThrow();
    }
  });
  test("editing retains full set, cannot disable it, and keeps shared session change warning", () => {
    for (const locale of ["zh", "en"] as const) {
      const copy = linksCopy(locale);
      const html = renderToStaticMarkup(<LinkBindingForm copy={copy} initial={bindingFromForward(targetLink().forwards[0])} busy={false} onCancel={noop} onSubmit={async () => {}} />);
      expect(html).toContain(copy.targetsKeepSetHint); expect(html).toMatch(/type="checkbox"[^>]*disabled/);
      expect(html).toContain('type="hidden" name="target_set_enabled" value="1"');
      expect(html).toContain('name="target_strategy"'); expect(html).toContain('value="40"');
      expect(html).toContain(copy.updateHint); expect(html).toContain(copy.moveTargetUp); expect(html).toContain(copy.removeTarget);
      const detail = renderToStaticMarkup(<LinkDetailView link={targetLink()} copy={copy} now={now} canManage={false} busy={false} nodeLabel={String}
        onEdit={noop} onDeploy={noop} onRotate={noop} onRetire={noop} onAdd={noop} onEditForward={noop} onAction={noop} />);
      expect(detail).not.toContain("<button"); expect(detail).toContain(copy.targetHealth);
    }
  });
  test("UDP defaults none, stored auxiliary TCP remains explicit, both retains TCP", () => {
    for (const protocol of ["tcp", "udp", "both"] as const) {
      const html = renderToStaticMarkup(<LinkBindingForm copy={linksCopy("en")} initial={{ ...binding, protocol, target_set: targetSet({ probe: protocol === "udp" ? "none" : "tcp" }) }} busy={false} onCancel={noop} onSubmit={async () => {}} />);
      expect(html).toContain(protocol === "udp" ? '<option value="none" selected="">' : '<option value="tcp" selected="">');
      if (protocol !== "tcp") expect(html).toContain(linksCopy("en").udpProbeHint);
    }
    const html = renderToStaticMarkup(<LinkBindingForm copy={linksCopy("en")} initial={{ ...binding, protocol: "udp", target_set: targetSet() }} busy={false} onCancel={noop} onSubmit={async () => {}} />);
    expect(html).toContain('<option value="tcp" selected="">Auxiliary TCP probe');
  });
  test("requests carry full set, captured revision CAS and original Workspace/session/CSRF", async () => {
    const input = parseLinkBindingForm(data()); const calls: { method: string; body: unknown }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init!.headers as Record<string, string>;
      expect(headers["x-workspace-id"]).toBe("5"); expect(headers["X-CSRF-Token"]).toBe("1"); expect(init!.credentials).toBe("include");
      calls.push({ method: init!.method!, body: JSON.parse(String(init!.body)) });
      return Response.json({ data: String(url).endsWith("/forwards") ? { id: 7, link_id: 3 } : targetLink() });
    }) as typeof fetch;
    await linksApi.createForward(5, 3, input); await linksApi.updateForward(5, 3, 7, 8, input);
    expect(calls).toEqual([{ method: "POST", body: input }, { method: "PUT", body: { expected_revision: 8, binding: input } }]);
  });
  test("missing capability and required-set errors are actionable bilingual copy, raw exceptions stay hidden", () => {
    for (const locale of ["zh", "en"] as const) {
      const copy = linksCopy(locale);
      for (const [code, expected] of [["agent_fxp_targets_capability_missing", copy.targetsCapabilityMissing], ["link_target_set_required", copy.targetSetRequired], ["agent_fxp_capability_missing", copy.fxpCapabilityMissing]]) {
        const info = linkErrorInfo(new ApiError(409, "key=never-visible", { code }));
        expect(linkErrorMessage(info, copy)).toBe(expected); expect(linkErrorMessage(info, copy)).not.toContain("never-visible");
      }
      expect(copy.targetsCapabilityMissing).toContain("forward.targets.fxp.v1");
    }
  });
});
