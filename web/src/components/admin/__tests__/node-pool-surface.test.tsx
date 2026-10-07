import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en, zh } from "@/lib/i18n/dictionaries";

const MANAGER_SRC = readFileSync(resolve(import.meta.dir, "..", "node-groups-manager.tsx"), "utf8");

describe("admin node-pool product surface", () => {
  test("node groups are presented as node pools with purpose language", () => {
    expect(zh.admin.nodeGroups).toBe("节点池");
    expect(en.admin.nodeGroups).toBe("Node pools");
    expect(zh.admin.nodePoolPurposeIngress).toBe("入口用途");
    expect(zh.admin.nodePoolPurposeEgress).toBe("出口用途");
    expect(zh.fields.nodeType).toBe("节点池用途");
  });

  test("main list shows resource facts instead of group credentials", () => {
    const tableStart = MANAGER_SRC.indexOf("<Table>");
    const tableEnd = MANAGER_SRC.indexOf("</Table>", tableStart);
    const table = MANAGER_SRC.slice(tableStart, tableEnd);

    expect(table).toContain('t("admin.nodePoolNodes")');
    expect(table).toContain("g.online_node_count");
    expect(table).toContain("g.node_count");
    expect(table).toContain("g.port_range");
    expect(table).not.toContain("g.token");
    expect(table).not.toContain("g.traffic_rate");
  });

  test("advanced compatibility settings are collapsed by default", () => {
    expect(MANAGER_SRC).toContain('data-testid="node-pool-basic-settings"');
    expect(MANAGER_SRC).toContain('data-testid="node-pool-advanced-settings"');
    expect(MANAGER_SRC).toContain("<details");
    expect(MANAGER_SRC).not.toContain("<details open");
    expect(MANAGER_SRC).toContain('type="password"');
    expect(MANAGER_SRC).toContain('t("admin.nodePoolTokenHint")');
  });

  test("ordinary user copy does not expose entitlement or RBAC resource keys", () => {
    const userNodeCopy = JSON.stringify(zh.node);
    expect(userNodeCopy).not.toContain("allow_custom_in_group");
    expect(userNodeCopy).not.toContain("allow_custom_out_group");
    expect(userNodeCopy).not.toContain("node:manage");
    expect(userNodeCopy).not.toContain("node:read");
    expect(userNodeCopy).not.toContain("节点组");
  });
});
