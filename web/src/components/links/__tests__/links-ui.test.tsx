import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LinkBindingForm, LinkConfigForm, parseLinkBindingForm, parseLinkConfigForm } from "../link-forms";
import { LinkDetailView } from "../link-detail";
import { linksCopy } from "../links-copy";
import { bindingFromForward, canEditLinkEndpoints, canRetireLink, createLinksScopeFence, linkErrorMessage, linkLiveState, placementState, linkIdFromSelection } from "../link-state";
import { LinkedForwardGuide, linkedForwardHref, isLinkManagedError } from "../linked-forward-guide";
import { ApiError } from "@/lib/api/core";
import { binding, forward, link, traffic } from "./links-fixtures";
import { projectLinkDetail, type LinkDetail } from "@/lib/links-types";
import { localizedLabel, userConsoleNav } from "@/lib/nav";

const copy = linksCopy("zh");
const noop = () => {};
function markup(data: LinkDetail, manage = true, now = Date.parse("2029-01-01T00:00:00Z"), labels = copy) {
  return renderToStaticMarkup(<LinkDetailView link={data} copy={labels} canManage={manage} busy={false} now={now} nodeLabel={(id) => `Node ${id}`}
    onEdit={noop} onDeploy={noop} onRotate={noop} onRetire={noop} onAdd={noop} onEditForward={noop} onAction={noop} />);
}
function bindingData(over: Record<string, string> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries({ ...binding, ...over })) data.set(key, String(value));
  return data;
}
describe("links real form boundaries", () => {
  test("both, zero limits and per-IP concurrent connections preserve units and values", () => {
    expect(parseLinkBindingForm(bindingData())).toEqual(binding);
    expect(parseLinkBindingForm(bindingData({ bytes_per_second_in: "0", max_connections_per_ip: "0" }))).toMatchObject({ bytes_per_second_in: 0, max_connections_per_ip: 0 });
    const html = renderToStaticMarkup(<LinkBindingForm copy={copy} busy={false} onCancel={noop} onSubmit={async () => {}} />);
    expect(html).toContain("TCP + UDP"); expect(html).toContain("字节/秒");
    expect(html).toContain("每个来源 IP 的并发连接数"); expect(html).not.toContain("独立 IP 数");
  });
  test("reject blank, fractional, overflowing and negative numbers and URL targets", () => {
    for (const value of ["", "0", "65536", "1.5", "-1"]) expect(() => parseLinkBindingForm(bindingData({ listen_port: value }))).toThrow();
    for (const value of ["-1", "1.5", "2147483648"]) expect(() => parseLinkBindingForm(bindingData({ bytes_per_second_in: value }))).toThrow();
    expect(() => parseLinkBindingForm(bindingData({ max_connections_per_ip: "1000001" }))).toThrow();
    expect(() => parseLinkBindingForm(bindingData({ target_host: "https://host/path" }))).toThrow();
    expect(() => parseLinkBindingForm(bindingData({ name: " " }))).toThrow();
  });
  test("edit does not change protocol and retains loopback scope", () => {
    const data = bindingData({ protocol: "udp", listen_host: "::1" });
    expect(parseLinkBindingForm(data, "tcp").protocol).toBe("tcp");
    expect(bindingFromForward(forward({ listen_ip: "::1" })).listen_host).toBe("::1");
    const html = renderToStaticMarkup(<LinkBindingForm copy={copy} busy={false} initial={binding} onCancel={noop} onSubmit={async () => {}} />);
    expect(html).toMatch(/name="protocol"[^>]*disabled/); expect(html).toContain(copy.protocolLocked);
  });
  test("point-to-point needs different nodes and an explicit carrier port", () => {
    const data = new FormData(); data.set("ingress_node_id", "11"); data.set("egress_node_id", "12"); data.set("carrier_port", "26001");
    expect(parseLinkConfigForm(data)).toEqual(link().config!);
    data.set("egress_node_id", "11"); expect(() => parseLinkConfigForm(data)).toThrow();
    data.set("egress_node_id", "12"); data.set("carrier_port", ""); expect(() => parseLinkConfigForm(data)).toThrow();
    const html = renderToStaticMarkup(<LinkConfigForm copy={copy} nodes={[]} nodesError={true} busy={false} onCancel={noop} onSubmit={async () => {}} />);
    expect(html).toContain(copy.nodesFailed); expect(html).toMatch(/<fieldset[^>]*disabled/);
  });
});

describe("historical forward traffic, not live readiness", () => {
  const now = Date.parse("2029-01-01T00:00:00Z");
  function fact(html: string, label: string) {
    return html.split(`${label}</dt>`)[1]?.match(/^<dd[^>]*>([^<]*)<\/dd>/)?.[1];
  }
  test("missing and nullable traffic render not received in both languages", () => {
    for (const labels of [copy, linksCopy("en")]) {
      for (const value of [undefined, null]) {
        const html = markup(projectLinkDetail(link({ forwards: [forward({ traffic: value })] }), 5), false, now, labels);
        for (const label of [labels.trafficIn, labels.trafficOut, labels.trafficConnections, labels.trafficLastReceived]) {
          expect(fact(html, label)).toBe(labels.trafficNotReceived);
        }
        expect(html).toContain(labels.trafficHint); expect(html).not.toContain("0 B");
        expect(html).not.toContain(labels.trafficStale); expect(html).not.toContain(labels.statusRunning);
      }
    }
  });
  test("actual zero is 0 B and 0 admitted connections, not missing or a concurrency limit", () => {
    for (const labels of [copy, linksCopy("en")]) {
      const zero = traffic({ bytes_in: "0", bytes_out: "0", connections: "0" });
      const html = markup(link({ forwards: [forward({ traffic: zero })] }), false, now, labels);
      expect(fact(html, labels.trafficIn)).toBe("0 B"); expect(fact(html, labels.trafficOut)).toBe("0 B");
      expect(fact(html, labels.trafficConnections)).toBe("0");
      expect(fact(html, labels.trafficLastReceived)).toBe(zero.last_received_at);
      expect(fact(html, labels.connections)).toBe("30");
      expect(html).not.toContain(labels.trafficNotReceived); expect(html).not.toContain(labels.trafficStale);
    }
  });
  test("directional bytes and connection counts above MAX_SAFE_INTEGER render exactly", () => {
    const huge = traffic({ bytes_in: "18446744073709551617", bytes_out: "900719925474099312345678901234567890", connections: "9007199254740993" });
    const html = markup(projectLinkDetail(link({ forwards: [forward({ traffic: huge })] }), 5), false);
    expect(fact(html, copy.trafficIn)).toBe(`${huge.bytes_in} B`);
    expect(fact(html, copy.trafficOut)).toBe(`${huge.bytes_out} B`);
    expect(fact(html, copy.trafficConnections)).toBe(huge.connections);
    expect(html).not.toMatch(/\d(?:\.\d+)?e\+\d/);
    expect(html).toContain("sm:grid-cols-2"); expect(html).toContain("break-all");
  });
  test("fresh receipt does not turn missing runtime observations into running", () => {
    const data = projectLinkDetail(link({ forwards: [forward({ traffic: traffic() })] }), 5);
    expect(placementState(data, data.deployment!.placements[0], now)).toBe("unknown");
    const html = markup(data);
    expect(fact(html, copy.trafficLastReceived)).toBe(traffic().last_received_at);
    expect(html).not.toContain(copy.statusRunning); expect(html).not.toContain(copy.trafficStale);
    data.deployment!.placements[0].observation = { state: "unrecognized_runtime", ready: true, observed_generation: 4 };
    expect(placementState(data, data.deployment!.placements[0], now)).toBe("unknown");
    expect(markup(data)).not.toContain(copy.statusRunning);
  });
  test("at 60 seconds and later, old counters remain visible and are explicitly not current zero", () => {
    for (const labels of [copy, linksCopy("en")]) {
      const snapshot = traffic(); const data = link({ forwards: [forward({ traffic: snapshot })] });
      expect(markup(data, false, now + 59_999, labels)).not.toContain(labels.trafficStale);
      for (const age of [60_000, 60_001, 86_400_000]) {
        const html = markup(data, false, now + age, labels);
        expect(html).toContain(labels.trafficStale); expect(html).not.toContain(labels.statusRunning);
        expect(fact(html, labels.trafficIn)).toBe("1024 B"); expect(fact(html, labels.trafficOut)).toBe("2048 B");
        expect(fact(html, labels.trafficConnections)).toBe("7");
        expect(fact(html, labels.trafficLastReceived)).toBe(snapshot.last_received_at);
      }
    }
  });
  test("old traffic neither overrides live readiness nor disappears on stopped or expired runtime", () => {
    const data = link({ forwards: [forward({ traffic: traffic({ last_received_at: "2028-12-31T00:00:00Z" }) })] });
    data.deployment!.placements[0].observation = { state: "ready", ready: true, observed_generation: 4 };
    expect(markup(data)).toContain(copy.statusRunning); expect(markup(data)).toContain(copy.trafficStale);
    for (const state of ["closed", "removed", "failed", "stale"]) {
      data.deployment!.placements[0].observation = { state, ready: false, observed_generation: 4 };
      const html = markup(data);
      expect(html).not.toContain(copy.statusRunning); expect(fact(html, copy.trafficIn)).toBe("1024 B");
      expect(html).toContain(copy.trafficStale);
    }
    const expired = markup(data, false, Date.parse("2031-01-01T00:00:00Z"));
    expect(expired).toContain(copy.expired); expect(fact(expired, copy.trafficConnections)).toBe("7");
  });
  test("future receipt is flagged as clock difference, not fresh evidence of online traffic", () => {
    for (const labels of [copy, linksCopy("en")]) {
      const future = traffic({ last_received_at: "2029-01-01T00:00:01Z" });
      const html = markup(projectLinkDetail(link({ forwards: [forward({ traffic: future })] }), 5), false, now, labels);
      expect(html).toContain(renderToStaticMarkup(<>{labels.trafficFuture}</>)); expect(html).not.toContain(labels.trafficStale);
      expect(html).not.toContain(labels.statusRunning); expect(fact(html, labels.trafficConnections)).toBe("7");
      expect(fact(html, labels.trafficLastReceived)).toBe(future.last_received_at);
    }
  });
  test("each rule owns its snapshot; unrelated raw runtime and secret fields never render", () => {
    const data = projectLinkDetail({ ...link(), forwards: [
      { ...forward(), traffic: null, runtime: { ready: true, process: "never-visible" } },
      { ...forward({ id: 8, name: "Second rule" }), traffic: { ...traffic({ bytes_in: "0" }), key: "never-visible", config: "never-visible" } },
    ] }, 5);
    const html = markup(data, false);
    const articles = html.match(/<article\b[^>]*>[\s\S]*?<\/article>/g)!;
    expect(articles).toHaveLength(2);
    expect(fact(articles[0], copy.trafficIn)).toBe(copy.trafficNotReceived);
    expect(fact(articles[1], copy.trafficIn)).toBe("0 B"); expect(fact(articles[1], copy.trafficOut)).toBe("2048 B");
    expect(html).not.toContain("never-visible"); expect(html).not.toContain(copy.statusRunning);
  });
});
describe("truthful deployment and references", () => {
  test("suspended references block endpoint moves and tunnel retirement", () => {
    const data = link({ forwards: [forward({ desired_status: "inactive", apply_status: "suspended" })] });
    expect(canEditLinkEndpoints(data)).toBe(false);
    const html = markup(data);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>编辑端点<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>删除隧道<\/button>/);
    expect(html).toContain(copy.resume);
    expect(canEditLinkEndpoints(link({ ref_count: 0, forwards: [], generation: 0 }))).toBe(true);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>轮换密钥<\/button>/);
    expect(html).toContain("link_has_references");
  });
  test("deployed endpoints stay locked even after deleting every reference; retirement stays available", () => {
    const data = link({ ref_count: 0, forwards: [] });
    expect(canEditLinkEndpoints(data)).toBe(false); expect(canRetireLink(data)).toBe(true);
    const html = markup(data);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>编辑端点<\/button>/);
    expect(html).toContain("link_config_requires_retirement");
    expect(html).not.toMatch(/<button[^>]* disabled=""[^>]*>删除隧道<\/button>/);
    expect(html).not.toMatch(/<button[^>]* disabled=""[^>]*>轮换密钥<\/button>/);
  });
  test("expiry or wrong generation cannot appear as running", () => {
    const data = link(); const p = data.deployment!.placements[0];
    expect(placementState(data, p, Date.parse("2031-01-01Z"))).toBe("expired");
    expect(placementState(data, { ...p, applied_generation: 3 }, Date.parse("2029-01-01Z"))).toBe("unknown");
    const html = markup(data, true, Date.parse("2031-01-01Z"));
    expect(html).toContain(copy.expired); expect(html).not.toContain(copy.statusRunning); expect(html).not.toContain("online");
  });
  test("zero bindings show passive ingress, not an online business listener", () => {
    const data = link({ ref_count: 0, forwards: [] }); data.deployment!.placements[0].status = "passive";
    const html = markup(data); expect(html).toContain(copy.passiveHint); expect(html).toContain(copy.noForwards);
    expect(html).toContain(copy.ackHint);
  });
  test("an ACK alone never becomes a live runtime fact", () => {
    const data = link();
    expect(placementState(data, data.deployment!.placements[0], Date.parse("2029-01-01Z"))).toBe("unknown");
    const html = markup(data); expect(html).toContain(copy.appliedAck); expect(html).toContain(copy.runtimeState);
    expect(html).not.toContain(copy.statusRunning);
  });
  test("only matching fresh ready observation is live; passive=false means standby", () => {
    const data = link(); const p = data.deployment!.placements[0]; const now = Date.parse("2029-01-01Z");
    p.observation = { state: "ready", ready: true, observed_generation: 4 };
    expect(linkLiveState(data, p, now)).toBe("ready"); expect(markup(data)).toContain(copy.statusRunning);
    p.observation = { state: "ready", ready: null, observed_generation: 4 };
    expect(linkLiveState(data, p, now)).toBe("unknown");
    p.observation = { state: "ready", ready: true, observed_generation: 3 };
    expect(linkLiveState(data, p, now)).toBe("mismatch");
    p.observation = { state: "stale", ready: null, observed_generation: 4 };
    expect(linkLiveState(data, p, now)).toBe("stale"); expect(markup(data)).not.toContain(copy.statusRunning);
    p.observation = { state: "passive", ready: false, observed_generation: 4 };
    expect(linkLiveState(data, p, now)).toBe("passive"); expect(markup(data)).toContain(copy.passiveLive);
    for (const state of ["failed", "exited", "expired", "closed", "removed", "absent"]) {
      p.observation = { state, ready: false, observed_generation: 4 }; expect(linkLiveState(data, p, now)).toBe(state);
    }
  });
  test("update risk is explicit and machine codes live in support details", () => {
    const html = markup(link()); expect(html).toContain("现有连接可能中断");
    expect(html).toMatch(/<details[^>]*>.*link_config_requires_retirement.*<\/details>/);
    expect(html).not.toContain("无损");
  });
  test("a retired resource does not keep showing an older ready observation as running", () => {
    const data = link({ status: "retired" });
    data.deployment!.placements[0].observation = { state: "ready", ready: true, observed_generation: 4 };
    expect(linkLiveState(data, data.deployment!.placements[0], Date.parse("2029-01-01Z"))).toBe("removed");
    const html = markup(data); expect(html).not.toContain(copy.statusRunning); expect(html).not.toContain(copy.rotateZeroRefs);
  });
  test("policy refusal is a deployment reason; old ACK never substitutes for removed/expired runtime", () => {
    const data = link({ status: "degraded" }); data.deployment!.status = "policy_blocked";
    data.deployment!.placements.forEach((p) => { p.observation = { state: "removed", ready: false, observed_generation: 4 }; });
    const html = markup(data);
    expect(html).toContain(copy.statusDegraded); expect(html).toContain(copy.statusPolicyBlocked);
    expect(html).toContain(copy.policyBlockedHint); expect(html).toContain(copy.removed);
    expect(html).toContain(copy.appliedAck); expect(html).not.toContain(copy.statusRunning);
    expect(html).toMatch(/<details[^>]*>.*policy_blocked.*<\/details>/);
    expect(markup(data, true, Date.parse("2031-01-01Z"))).toContain(copy.expired);
  });
  test("policy restore uses new deployment facts and action revisions remain server-owned", () => {
    const data = link({ generation: 5, forwards: [forward({ desired_status: "inactive", apply_status: "pending", config_revision: 10, applied_revision: 9 })] });
    data.deployment!.generation = 5; data.deployment!.status = "pending";
    data.deployment!.placements.forEach((p) => { p.generation = 5; p.applied_generation = 4;
      p.observation = { state: "ready", ready: true, observed_generation: 4 }; });
    let html = markup(data);
    expect(html).toContain(copy.mismatch); expect(html).not.toContain(copy.statusRunning);
    expect(html).toContain("期望版本: 10"); expect(html).toContain("已应用: 9");
    data.deployment!.status = "active"; data.forwards[0].apply_status = "suspended"; data.forwards[0].applied_revision = 10;
    data.deployment!.placements.forEach((p) => { p.applied_generation = 5;
      p.observation = { state: "ready", ready: true, observed_generation: 5 }; });
    html = markup(data);
    expect(html).toContain(copy.statusRunning); expect(html).toContain(copy.statusSuspended);
    expect(html).toContain("已应用: 10"); expect(html).not.toContain(copy.policyBlockedHint);
  });
  test("active desired is different from an old applied revision", () => {
    const html = markup(link({ forwards: [forward({ config_revision: 9, applied_revision: 8 })] }));
    expect(html).toContain(copy.statusPending); expect(html).toContain("期望版本: 9"); expect(html).toContain("已应用: 8");
  });
  test("an older deployment does not stand in for the desired configuration version", () => {
    const data = link({ desired_version: 3 }); data.deployment!.version = 2;
    const html = markup(data);
    expect(html).toContain(copy.appliedVersion);
    expect(html).toMatch(/已应用配置版本<\/dt><dd[^>]*>2<\/dd>/);
    expect(markup(link())).toMatch(/已应用配置版本<\/dt><dd[^>]*>未知<\/dd>/);
  });
  test("view-only users see no mutation buttons", () => {
    const html = markup(link(), false);
    expect(html).not.toContain("<button"); expect(html).toContain(copy.target); expect(html).toContain(copy.lease);
  });
  test("feature flag and CAS conflict have clear failure copy in both languages", () => {
    const disabled = { code: "fxp_links_not_enabled", disabled: true, conflict: false, denied: false };
    expect(linkErrorMessage(disabled, copy)).toContain("操作未执行");
    expect(linkErrorMessage(disabled, linksCopy("en"))).toContain("not performed");
    expect(linkErrorMessage({ ...disabled, disabled: false, conflict: true }, copy)).toContain("重新读取");
    expect(linkErrorMessage({ ...disabled, code: "link_config_requires_retirement", disabled: false }, copy)).toBe(copy.endpointRetire);
    expect(linkErrorMessage({ ...disabled, code: "link_has_references", disabled: false }, copy)).toBe(copy.zeroRefs);
  });
  test("node management does not grant separate forwarding mutations", () => {
    const html = renderToStaticMarkup(<LinkDetailView link={link()} copy={copy} canManage={true} busy={false} now={Date.parse("2029-01-01Z")}
      nodeLabel={String} onEdit={noop} onDeploy={noop} onRotate={noop} onRetire={noop} onAdd={noop} onEditForward={noop} onAction={noop}
      canCreateForward={false} canUpdateForward={() => false} canDeleteForward={() => false} />);
    expect(html).not.toContain(copy.addForward); expect(html).not.toContain(copy.editForward); expect(html).not.toContain(copy.delete);
  });
});
describe("workspace fencing and navigation", () => {
  test("late success, failure and finally tickets all expire on permission or scope change", async () => {
    const fence = createLinksScopeFence(); fence.setScope("workspace-5-manager");
    const read = fence.next("read"); const mutation = fence.next("mutation");
    fence.setScope("workspace-6-viewer"); await Promise.resolve();
    expect(fence.current(read)).toBe(false); expect(fence.current(mutation)).toBe(false);
    const fresh = fence.next("read"); expect(fence.current(fresh)).toBe(true);
    fence.next("read"); expect(fence.current(fresh)).toBe(false);
  });
  test("links is a real bilingual user-console route", () => {
    const item = userConsoleNav.flatMap((g) => g.items).find((item) => item.href === "/links")!;
    expect(item.status ?? "available").toBe("available");
    expect(localizedLabel("zh", item.labelKey, item.labelZh!, item.labelEn!)).toBe("加密隧道");
    expect(localizedLabel("en", item.labelKey, item.labelZh!, item.labelEn!)).toBe("Encrypted tunnels");
  });
  test("linked native rows guide to the exact carrier and selection input stays bounded", () => {
    expect(linkedForwardHref({ link_resource_id: 3 })).toBe("/links?selected=3");
    expect(linkedForwardHref({ link_resource_id: -1 })).toBe(null);
    expect(linkedForwardHref({ link_resource_id: null })).toBe(null);
    const html = renderToStaticMarkup(<LinkedForwardGuide forward={{ name: "Shared rule", link_resource_id: 3 }} locale="zh" />);
    expect(html).toContain('href="/links?selected=3"'); expect(html).toContain("前往隧道管理");
    expect(isLinkManagedError(new ApiError(409, "managed", { code: "link_managed_forward" }))).toBe(true);
    for (const value of [null, "", "0", "-1", "3.1", "2147483648", "3?other", "03"]) expect(linkIdFromSelection(value)).toBe(null);
    expect(linkIdFromSelection("3")).toBe(3);
  });
});
