import { expect, test } from "bun:test";
import { forwardPolicyDraft, forwardPolicyDraftErrors, forwardPolicyDraftPatch, forwardPolicyDraftValues } from "@/lib/forward-policy";
import { forwardCopyCreateInput, forwardCopyDraft } from "../forward-copy";
import { draftFormErrors, draftToPatch } from "../forward-edit-dialog";
import type { PortForward } from "@/lib/types";
test("policy forms preserve request units and only send changed fields", () => {
  const current = { bytes_per_second_in: 1234, max_connections: 20 };
  const draft = forwardPolicyDraft(current);
  expect(forwardPolicyDraftValues(draft)).toMatchObject({ bytes_per_second_in: 1234, max_connections: 20 });
  expect(forwardPolicyDraftPatch(current, draft)).toEqual({});
  expect(forwardPolicyDraftPatch(current, { ...draft, max_connections: "0" })).toEqual({ max_connections: 0 });
  expect(forwardPolicyDraftPatch(current, {})).toEqual({});
});
test("UI rejects invalid integers, exponent/hex spellings and values beyond Int JSON range", () => {
  for (const raw of ["-1", "0.5", "1e3", "0x10", "NaN", "2147483648"]) {
    expect(forwardPolicyDraftErrors({ bytes_per_second_in: raw })).toHaveProperty("bytes_per_second_in");
  }
  expect(forwardPolicyDraftValues({ bytes_per_second_in: "2147483647", max_connections: "" }))
    .toMatchObject({ bytes_per_second_in: 2147483647, max_connections: 0 });
});
test("copy retains four requested caps and a policy-only edit is one patch", () => {
  const forward = { name: "policy", protocol: "tcp", mode: "direct", ingress_node_id: 1, target_host: "example.com", target_port: 80,
    listen_port: 20000, bytes_per_second_in: 1000, bytes_per_second_out: 2000, max_connections: 5, max_connections_per_ip: 2 } as PortForward;
  const copy = forwardCopyDraft(forward, " copy");
  expect(forwardCopyCreateInput(copy)).toMatchObject({ bytes_per_second_in: 1000, bytes_per_second_out: 2000, max_connections: 5, max_connections_per_ip: 2 });
  const edit = { ...copy, name: forward.name, listenPort: "20000", max_connections: "0" };
  expect(draftToPatch(forward, edit)).toEqual({ max_connections: 0 });
  const invalid = { ...edit, bytes_per_second_in: "-1" };
  expect(draftFormErrors(invalid, (key) => key)).toHaveProperty("bytes_per_second_in");
  expect(() => draftToPatch(forward, invalid)).not.toThrow();
});
