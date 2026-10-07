import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError, setActiveWorkspace } from "@/lib/api/core";
import { linksApi, linkErrorInfo } from "@/lib/links-api";
import { canonicalLinkTrustedCIDR, isLinkTrustedCIDR, projectLinkClientSource, projectLinkDetail, LinksPayloadError, type LinkClientSource } from "@/lib/links-types";
import { LinkBindingForm, parseLinkBindingForm } from "../link-forms";
import { LinkDetailView } from "../link-detail";
import { LinkErrorDetails } from "../link-error-details";
import { bindingFromForward, linkErrorMessage } from "../link-state";
import { linksCopy } from "../links-copy";
import { binding, forward, link, targetSet } from "./links-fixtures";

const off: LinkClientSource = { version: 1, receive_proxy: false, trusted_cidrs: [], send_proxy: "off" };
const source: LinkClientSource = { version: 1, receive_proxy: true, trusted_cidrs: ["192.0.2.0/24", "2001:db8::/32"], send_proxy: "v2" };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; setActiveWorkspace(null); });
const noop = () => {};
function data(withSource = true, multiple = false) {
  const d = new FormData();
  for (const [key, value] of Object.entries({ ...binding, protocol: "tcp" })) d.set(key, String(value));
  if (withSource) {
    d.set("client_source_enabled", "1"); d.set("receive_proxy", "1");
    d.set("trusted_cidrs", source.trusted_cidrs.join("\n")); d.set("send_proxy", "v2");
  }
  if (multiple) {
    d.set("target_set_enabled", "1"); d.append("target_host", "127.0.0.2"); d.append("target_port", "25002");
    d.set("target_strategy", "ip_hash"); d.set("target_probe", "tcp"); d.set("target_failure_seconds", "30"); d.set("target_recover_seconds", "40");
  }
  return d;
}
const row = (client_source = source) => link({ forwards: [forward({ forward_protocol: "tcp", client_source: { ...client_source, trusted_cidrs: [...client_source.trusted_cidrs] }, target_set: targetSet({ strategy: "ip_hash" }) })] });
const form = (initial?: ReturnType<typeof bindingFromForward>, locale: "en" | "zh" = "en") => renderToStaticMarkup(<LinkBindingForm copy={linksCopy(locale)} initial={initial} busy={false} onCancel={noop} onSubmit={async () => {}} />);
const detail = (client_source = source, locale: "en" | "zh" = "en") => renderToStaticMarkup(<LinkDetailView link={row(client_source)} copy={linksCopy(locale)} now={Date.parse("2029-01-01T00:00:00Z")} canManage={false} busy={false} nodeLabel={String} onEdit={noop} onDeploy={noop} onRotate={noop} onRetire={noop} onAdd={noop} onEditForward={noop} onAction={noop} />);

describe("F3 closed client source contract", () => {
  test("legacy remains absent; explicit all-off is not absence", () => {
    expect(projectLinkDetail(link(), 5).forwards[0]).not.toHaveProperty("client_source");
    expect(parseLinkBindingForm(data(false))).not.toHaveProperty("client_source");
    expect(projectLinkDetail(row(off), 5).forwards[0].client_source).toEqual(off);
    expect(bindingFromForward(projectLinkDetail(row(off), 5).forwards[0]).client_source).toEqual(off);
  });
  test("closed projection strips unknown source facts and clones trust arrays on edit", () => {
    const raw = row(); Object.assign(raw.forwards[0].client_source!, { source_health: "never-visible", header: "never-visible" });
    const projected = projectLinkDetail(raw, 5);
    expect(projected.forwards[0].client_source).toEqual(source);
    expect(JSON.stringify(projected)).not.toContain("never-visible");
    const input = bindingFromForward(projected.forwards[0]); input.client_source!.trusted_cidrs[0] = "203.0.113.0/24";
    expect(projected.forwards[0].client_source!.trusted_cidrs).toEqual(source.trusted_cidrs);
  });
  test("required fields, version, booleans and enums are strict", () => {
    for (const bad of [null, [], {}, false, "{}", { ...off, version: 2 }, { ...off, receive_proxy: "false" }, { ...off, send_proxy: "V2" }, { ...off, trusted_cidrs: null }]) expect(() => projectLinkClientSource(bad)).toThrow(LinksPayloadError);
    for (const key of Object.keys(off)) { const bad: Record<string, unknown> = { ...off }; delete bad[key]; expect(() => projectLinkClientSource(bad)).toThrow(LinksPayloadError); }
    for (const send_proxy of ["off", "v1", "v2"] as const) expect(projectLinkClientSource({ ...off, send_proxy })).toEqual({ ...off, send_proxy });
  });
  test("trust is IP CIDRs only, max32, never /0, and required for receive", () => {
    for (const valid of ["192.0.2.1/32", "192.0.2.0/1", "2001:db8::/128", "::/1"]) expect(isLinkTrustedCIDR(valid)).toBe(true);
    for (const bad of ["0.0.0.0/0", "::/0", "::ffff:192.0.2.1/128", "::ffff:c000:201/96", "0:0:0:0:0:ffff:c000:201/120", "host/24", "192.0.2.1", "[::1]/128", "::1%lo/128", "192.0.2.1/33", "::/129", "192.0.2.999/24", "192.00.2.1/24", "192.0.2.1/1.5", "::/01", "::/128\n", " ::/128", "::gg/64"]) {
      expect(isLinkTrustedCIDR(bad)).toBe(false); expect(() => projectLinkClientSource({ ...off, trusted_cidrs: [bad] })).toThrow(LinksPayloadError);
    }
    expect(() => projectLinkClientSource({ ...off, receive_proxy: true })).toThrow(LinksPayloadError);
    expect(projectLinkClientSource({ ...source, trusted_cidrs: Array.from({ length: 32 }, (_, i) => `192.0.2.${i}/32`) }).trusted_cidrs).toHaveLength(32);
    expect(() => projectLinkClientSource({ ...source, trusted_cidrs: Array(33).fill("192.0.2.0/24") })).toThrow(LinksPayloadError);
  });
  test("CIDRs mask host bits and canonicalize IPv6; mapped IPv6 never changes family", () => {
    const vectors = [["255.255.255.255/1", "128.0.0.0/1"], ["192.0.2.129/25", "192.0.2.128/25"],
      ["192.0.2.3/32", "192.0.2.3/32"], ["2001:0DB8:1234:5678::9/48", "2001:db8:1234::/48"],
      ["2001:db8:ffff::1/33", "2001:db8:8000::/33"], ["FFFF::1/1", "8000::/1"], ["::1/128", "::1/128"],
      ["2001:db8::192.0.2.129/120", "2001:db8::c000:200/120"]];
    for (const [input, expected] of vectors) expect(canonicalLinkTrustedCIDR(input)).toBe(expected);
    expect(projectLinkClientSource({ ...source, trusted_cidrs: vectors.map(([input]) => input) }).trusted_cidrs).toEqual(vectors.map(([, expected]) => expected));
    expect(() => projectLinkClientSource({ ...source, receive_proxy: false })).toThrow(LinksPayloadError);
  });
  test("duplicate trust networks are rejected after canonical masking at response and form boundaries", () => {
    const duplicates = [
      ["127.0.0.1/8", "127.0.0.2/8"],
      ["127.0.0.0/8", "127.0.0.0/8"],
      ["192.0.2.129/25", "192.0.2.254/25"],
      ["2001:0DB8:1234:5678::9/48", "2001:db8:1234::abcd/48"],
      ["2001:db8::192.0.2.129/120", "2001:db8::c000:2ff/120"],
    ];
    for (const trusted_cidrs of duplicates) {
      const config = { ...source, trusted_cidrs };
      expect(() => projectLinkClientSource(config)).toThrow(LinksPayloadError);
      expect(() => projectLinkDetail(row(config), 5)).toThrow(LinksPayloadError);
      const input = data(); input.set("trusted_cidrs", trusted_cidrs.join("\n"));
      expect(() => parseLinkBindingForm(input)).toThrow("invalid_client_source");
    }
    const atLimit = Array.from({ length: 32 }, (_, i) => `192.0.2.${i}/32`);
    atLimit[31] = atLimit[0];
    expect(() => projectLinkClientSource({ ...source, trusted_cidrs: atLimit })).toThrow(LinksPayloadError);
  });
  test("distinct normalized networks retain order and roundtrip through projection and edit forms", () => {
    const raw = ["127.0.0.1/8", "192.0.2.129/25", "2001:0DB8:1234:5678::9/48", "127.0.0.2/16"];
    const normalized = ["127.0.0.0/8", "192.0.2.128/25", "2001:db8:1234::/48", "127.0.0.0/16"];
    const before = [...raw];
    const config = { ...source, trusted_cidrs: raw };
    const projected = projectLinkClientSource(config);
    expect(projected.trusted_cidrs).toEqual(normalized);
    expect(projected.trusted_cidrs).not.toBe(raw);
    expect(config.trusted_cidrs).toEqual(before);
    expect(projectLinkClientSource(projected)).toEqual(projected);
    const response = projectLinkDetail(row(config), 5);
    expect(projectLinkDetail(response, 5)).toEqual(response);
    const initial = bindingFromForward(response.forwards[0]);
    expect(initial.client_source).toEqual(projected);
    expect(initial.client_source!.trusted_cidrs).not.toBe(response.forwards[0].client_source!.trusted_cidrs);
    const create = data(); create.set("trusted_cidrs", raw.join("\n"));
    expect(parseLinkBindingForm(create).client_source).toEqual(projected);
    const edit = data(); edit.set("client_source_present", "1");
    edit.set("trusted_cidrs", initial.client_source!.trusted_cidrs.join("\n"));
    expect(parseLinkBindingForm(edit, initial.protocol).client_source).toEqual(projected);
  });
  test("TCP-only applies even to all-off; IP hash requires explicit source", () => {
    for (const protocol of ["udp", "both"] as const) for (const config of [source, off]) {
      const raw = row(config); raw.forwards[0].forward_protocol = protocol;
      expect(() => projectLinkDetail(raw, 5)).toThrow(LinksPayloadError);
      const d = data(); d.set("protocol", protocol); expect(() => parseLinkBindingForm(d)).toThrow("client_source_tcp_only");
    }
    const raw = row(); delete raw.forwards[0].client_source; expect(() => projectLinkDetail(raw, 5)).toThrow(LinksPayloadError);
    expect(() => parseLinkBindingForm(data(false, true))).toThrow("ip_hash_requires_client_source");
    expect(parseLinkBindingForm(data(true, true)).target_set!.strategy).toBe("ip_hash");
    const d = data(false, true); d.set("client_source_present", "1"); expect(parseLinkBindingForm(d).client_source).toEqual(off);
  });
});

describe("F3 production forms, details and request fences", () => {
  test("create/edit roundtrip full source with IP hash and first-target order", () => {
    const d = data(true, true); d.delete("target_host"); d.delete("target_port");
    for (const t of [...targetSet().targets].reverse()) { d.append("target_host", t.host); d.append("target_port", String(t.port)); }
    const input = parseLinkBindingForm(d); expect(input.client_source).toEqual(source);
    expect(input.target_set!.targets).toEqual([...targetSet().targets].reverse());
    expect(input.target_host).toBe("127.0.0.2"); expect(input.target_port).toBe(25002);
    expect(bindingFromForward(projectLinkDetail(row(), 5).forwards[0]).client_source).toEqual(source);
  });
  test("known config disabling submits explicit all-off; untouched new legacy omits", () => {
    const d = data(false); d.set("client_source_present", "1"); expect(parseLinkBindingForm(d).client_source).toEqual(off);
    const html = form(bindingFromForward(row().forwards[0])); expect(html).toContain('name="client_source_present" value="1"');
    expect(html).toContain('name="receive_proxy"'); expect(html).toContain('name="send_proxy"'); expect(html).toContain("2001:db8::/32");
    expect(form()).not.toContain('name="client_source_present"'); expect(form()).not.toContain('name="send_proxy"');
  });
  test("receive errors and unsupported protocols are specific instead of generic target errors", () => {
    for (const cidrs of ["", "0.0.0.0/0", "::/0", "::ffff:192.0.2.1/128", "::ffff:c000:201/96", "0:0:0:0:0:ffff:c000:201/120", "host/24", Array(33).fill("192.0.2.0/24").join("\n")]) {
      const d = data(true, true); d.set("trusted_cidrs", cidrs); expect(() => parseLinkBindingForm(d)).toThrow("invalid_client_source");
    }
    const d = data(false); d.set("protocol", "both"); d.set("client_source_present", "1"); expect(() => parseLinkBindingForm(d)).toThrow("client_source_tcp_only");
  });
  test("source controls and IP hash are disabled on UDP/both, available only for explicit TCP source", () => {
    for (const protocol of ["udp", "both"] as const) {
      const html = form({ ...binding, protocol, target_set: targetSet() });
      expect(html).toMatch(/<input(?=[^>]*name="client_source_enabled")(?=[^>]*disabled)[^>]*>/);
      expect(html).toMatch(/value="ip_hash"[^>]*disabled/);
      expect(html).toContain(linksCopy("en").clientSourceTcpOnly);
    }
    expect(form({ ...binding, protocol: "tcp", target_set: targetSet() })).toMatch(/value="ip_hash"[^>]*disabled/);
    expect(form(bindingFromForward(row(off).forwards[0]))).not.toMatch(/value="ip_hash"[^>]*disabled/);
  });
  test("details declare socket/trusted PROXY, send mode, trust and remapping, not source health", () => {
    for (const locale of ["zh", "en"] as const) {
      const copy = linksCopy(locale);
      const html = detail(source, locale); expect(html).toContain(copy.clientSourcePolicy); expect(html).toContain(copy.sourceTrustedProxy);
      expect(html).toContain("192.0.2.0/24"); expect(html).toContain("PROXY v2"); expect(html).toContain(copy.sourcePolicyHint);
      expect(html).toContain(copy.ipHashRemapHint); expect(html).toContain(copy.sourceReceiveHint); expect(html).toContain(copy.sourceSendHint);
      expect(copy.sourceReceiveHint).toContain("108"); expect(copy.sourceReceiveHint).toContain("536");
      expect(detail(off, locale)).toContain(copy.sourceSocket); expect(detail(off, locale)).toContain(copy.sendProxyOff);
      expect(html).not.toContain("source_health"); expect(html).not.toContain("<button");
    }
  });
  test("source observations are not projected or rendered, even with a Ready ACK", () => {
    const raw = row(); const placement = raw.deployment!.placements[0];
    placement.observation = { state: "ready", ready: true, observed_generation: raw.generation };
    Object.assign(placement.observation, { source_status: { verified: true, actual_ip: "never-visible" }, source_health: "never-visible" });
    Object.assign(raw.forwards[0], { actual_client_source: "never-visible" });
    const projected = projectLinkDetail(raw, 5);
    expect(JSON.stringify(projected)).not.toContain("never-visible");
    expect(projected.deployment!.placements[0].observation).toEqual({ state: "ready", ready: true, observed_generation: raw.generation });
    expect(projected.forwards[0].client_source).toEqual(source);
    expect(detail()).not.toContain("never-visible");
  });
  test("safe API errors use actionable bilingual copy and collapsed support codes", () => {
    for (const locale of ["zh", "en"] as const) {
      const copy = linksCopy(locale);
      for (const [code, expected] of [["link_client_source_required", copy.clientSourceRequired], ["agent_fxp_source_capability_missing", copy.sourceCapabilityMissing], ["client_source_tcp_only", copy.clientSourceTcpOnly], ["ip_hash_requires_client_source", copy.ipHashRequiresClientSource], ["agent_fxp_client_source_capability_missing", copy.sourceCapabilityMissing], ["link_client_source_tcp_only", copy.clientSourceTcpOnly]]) {
        const info = linkErrorInfo(new ApiError(409, "secret=never-visible", { code }));
        expect(linkErrorMessage(info, copy)).toBe(expected); expect(linkErrorMessage(info, copy, true)).toBe(expected);
        const html = renderToStaticMarkup(<LinkErrorDetails codes={[info.code]} copy={copy} />);
        expect(html).toContain("<details"); expect(html).not.toContain("<details open"); expect(html).not.toContain("never-visible");
      }
      expect(copy.sourceCapabilityMissing).toContain("forward.client-source.fxp.v1");
    }
  });
  test("full source config retains explicit workspace, session, CSRF, order and captured CAS", async () => {
    setActiveWorkspace(99); const input = parseLinkBindingForm(data(true, true)); const calls: unknown[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init!.headers as Record<string, string>; expect(headers["x-workspace-id"]).toBe("5");
      expect(headers["X-CSRF-Token"]).toBe("1"); expect(init!.credentials).toBe("include");
      calls.push(JSON.parse(String(init!.body)));
      return Response.json({ data: String(url).endsWith("/forwards") ? { id: 7, link_id: 3 } : row() });
    }) as typeof fetch;
    await linksApi.createForward(5, 3, input); await linksApi.updateForward(5, 3, 7, 8, input);
    expect(calls).toEqual([input, { expected_revision: 8, binding: input }]);
  });
});
