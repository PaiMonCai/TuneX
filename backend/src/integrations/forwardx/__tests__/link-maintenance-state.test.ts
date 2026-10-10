import { describe, expect, test } from "bun:test";
import { signMaintenanceReceipt, verifyMaintenanceReceipt, maintenanceRequestDigest,
  LinkMaintenanceCommitSchema, LinkMaintenanceCancelSchema, maintenanceTransition,
  LINK_MAINTENANCE_HOLD_MS } from "../link-maintenance-state.ts";

const secret = "53".repeat(32);
const input = { expected_version: 2, expected_generation: 4, change: { type: "rotate_key" as const } };
const now = new Date("2026-10-10T02:00:00.000Z");
const claims = { workspace_id: 3, link_id: 7, state_token: "ab".repeat(32), request_digest: maintenanceRequestDigest(input) };

describe("F5 durable maintenance contract", () => {
  test("signed receipt binds scope, state, request and exactly 60 seconds", () => {
    const receipt = signMaintenanceReceipt(claims, secret, now);
    expect(verifyMaintenanceReceipt(receipt, claims, secret, now)).toEqual({
      version: 1, ...claims, issued_at: now.getTime(), expires_at: now.getTime() + 60_000,
    });
    expect(() => verifyMaintenanceReceipt(receipt, claims, secret, new Date(now.getTime() + 59_999))).not.toThrow();
    expect(() => verifyMaintenanceReceipt(receipt, claims, secret, new Date(now.getTime() + 60_000))).toThrow("link_maintenance_preview_expired");
  });
  test("receipt cannot be rebound to another tenant, Link, state or candidate", () => {
    const receipt = signMaintenanceReceipt(claims, secret, now);
    for (const changed of [{ workspace_id: 4 }, { link_id: 8 }, { state_token: "cd".repeat(32) },
      { request_digest: maintenanceRequestDigest({ ...input, change: { type: "update_endpoints", config: {
        ingress_node_id: 11, egress_node_id: 12, carrier_port: 25000 } } }) }]) {
      expect(() => verifyMaintenanceReceipt(receipt, { ...claims, ...changed }, secret, now)).toThrow("link_maintenance_preview_invalid");
    }
  });
  test("tampering, malformed receipts, a different installation key and future issue time fail closed", () => {
    const receipt = signMaintenanceReceipt(claims, secret, now);
    for (const bad of ["", "lm1.e30." + "ab".repeat(32), receipt + "x", receipt.replace("lm1.", "lm2."),
      receipt.slice(0, -1) + (receipt.endsWith("0") ? "1" : "0")]) {
      expect(() => verifyMaintenanceReceipt(bad, claims, secret, now)).toThrow("link_maintenance_preview_invalid");
    }
    expect(() => verifyMaintenanceReceipt(receipt, claims, "54".repeat(32), now)).toThrow("link_maintenance_preview_invalid");
    expect(() => verifyMaintenanceReceipt(receipt, claims, secret, new Date(now.getTime() - 5_001))).toThrow("link_maintenance_preview_invalid");
  });
  test("commit is strict, idempotency is canonical UUID, no secret or runtime fields accepted", () => {
    const valid = { ...input, idempotency_key: "4fcd5c30-8ee9-4a1e-8dc5-64267c5ee04a", receipt: "signed-receipt" };
    expect(LinkMaintenanceCommitSchema.parse(valid)).toEqual(valid);
    for (const bad of [{ ...valid, key: "private" }, { ...valid, execute: true },
      { ...valid, idempotency_key: valid.idempotency_key.toUpperCase() }, { ...valid, receipt: "" },
      { ...valid, change: { type: "rotate_key", secret: "private" } }]) {
      expect(LinkMaintenanceCommitSchema.safeParse(bad).success).toBe(false);
    }
    expect(LinkMaintenanceCancelSchema.safeParse({ expected_state_version: 1 }).success).toBe(true);
    expect(LinkMaintenanceCancelSchema.safeParse({ expected_state_version: 0 }).success).toBe(false);
    expect(LinkMaintenanceCancelSchema.safeParse({ expected_state_version: 1, state: "completed" }).success).toBe(false);
  });
  test("maintenance records can only close the awaiting-executor intent, never manufacture execution", () => {
    for (const status of ["cancelled", "expired", "invalidated"] as const) {
      expect(maintenanceTransition("awaiting_executor", 1, 1, status)).toEqual({ status, state_version: 2, active_link_id: null });
      expect(() => maintenanceTransition(status, 2, 2, "cancelled")).toThrow("link_maintenance_terminal");
    }
    expect(() => maintenanceTransition("awaiting_executor", 2, 1, "cancelled")).toThrow("link_maintenance_state_conflict");
    expect(LINK_MAINTENANCE_HOLD_MS).toBe(300_000);
  });
});
