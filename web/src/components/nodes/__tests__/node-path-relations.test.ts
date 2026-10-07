import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en, zh } from "@/lib/i18n/dictionaries";

const SRC = readFileSync(resolve(import.meta.dir, "..", "node-workspace.tsx"), "utf8");

describe("node path relationship product surface", () => {
  test("primary node copy talks about path relationships and next hops, not bindings", () => {
    expect(zh.node.bindings).toBe("路径关系");
    expect(zh.node.bindEgress).toBe("添加下一跳");
    expect(zh.node.bindingInfraHint).toContain("不会自动创建转发");
    expect(zh.node.noBindings).toContain("下一跳");
    expect(zh.node.subtitle).not.toContain("绑定");

    expect(en.node.bindings).toBe("Path relationships");
    expect(en.node.bindEgress).toBe("Add next hop");
    expect(en.node.bindingInfraHint).toContain("does not create forwards");
    expect(en.node.subtitle.toLowerCase()).not.toContain("binding");
  });

  test("empty relationship and no-more-candidate states are distinct", () => {
    expect(zh.node.noBindings).not.toBe(zh.node.noMoreNextHops);
    expect(zh.node.noBindings).toContain("还没有下一跳");
    expect(zh.node.noMoreNextHops).toContain("没有其它可添加");
    expect(en.node.noBindings).toContain("No next-hop node yet");
    expect(en.node.noMoreNextHops).toContain("no other next-hop node");
  });

  test("workspace renders source → next-hop relationships and protects in-use rows", () => {
    expect(SRC).toContain('data-testid="node-path-relation"');
    expect(SRC).toContain("<ArrowRight");
    expect(SRC).toContain('t("node.pathSource")');
    expect(SRC).toContain('t("node.nextHop")');
    expect(SRC).toContain("disabled={busy || usage.blocked}");
    expect(SRC).toContain('t("node.pathRelationInUseHint")');
  });

  test("product vocabulary changed without renaming backend API contracts", () => {
    // NodeBinding/bindEgress remain internal API terms. The product surface is
    // intentionally translated instead of changing the backend protocol.
    expect(SRC).toContain("api.nodes.bindEgress");
    expect(SRC).toContain("api.nodes.unbindEgress");
    expect(SRC).toContain('t("node.bindEgress")');
    expect(zh.node.bindEgress).not.toContain("绑定");
  });
});
