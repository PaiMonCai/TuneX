export const FORWARD_POLICY_MAX = 2147483647;
export const FORWARD_POLICY_FIELDS = ["bytes_per_second_in", "bytes_per_second_out", "max_connections", "max_connections_per_ip"] as const;
export type ForwardPolicyField = typeof FORWARD_POLICY_FIELDS[number];
export type ForwardPolicyInput = Partial<Record<ForwardPolicyField, number | null>>;
export type ForwardPolicyDraft = Partial<Record<ForwardPolicyField, string>>;

export function forwardPolicyDraft(input: ForwardPolicyInput = {}): ForwardPolicyDraft {
  return Object.fromEntries(FORWARD_POLICY_FIELDS.map((key) => [key, String(input[key] ?? 0)]));
}
export function forwardPolicyDraftErrors(draft: ForwardPolicyDraft): Partial<Record<ForwardPolicyField, string>> {
  return Object.fromEntries(FORWARD_POLICY_FIELDS.filter((key) => {
    const raw = (draft[key] ?? "0").trim();
    return raw !== "" && (!/^\d+$/.test(raw) || Number(raw) > FORWARD_POLICY_MAX);
  }).map((key) => [key, `0–${FORWARD_POLICY_MAX}`]));
}
export function forwardPolicyDraftValues(draft: ForwardPolicyDraft): Record<ForwardPolicyField, number> {
  if (Object.keys(forwardPolicyDraftErrors(draft)).length) throw new Error("Invalid Forward policy");
  return Object.fromEntries(FORWARD_POLICY_FIELDS.map((key) => [key, Number((draft[key] ?? "0").trim())])) as Record<ForwardPolicyField, number>;
}
export function forwardPolicyDraftPatch(current: ForwardPolicyInput, draft: ForwardPolicyDraft): ForwardPolicyInput {
  const values = forwardPolicyDraftValues(draft);
  return Object.fromEntries(FORWARD_POLICY_FIELDS.filter((key) => draft[key] !== undefined && values[key] !== (current[key] ?? 0))
    .map((key) => [key, values[key]]));
}
