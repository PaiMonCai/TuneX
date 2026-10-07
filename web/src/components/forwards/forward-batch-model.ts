import type { ForwardBatchAction, ForwardBatchInput, ForwardBatchResult } from "@/lib/types";

/** Snapshot selection at confirmation; cancelling must never create a delete request. */
export function prepareForwardBatchRequest(
  action: ForwardBatchAction,
  selectedIds: readonly number[],
  confirmDelete: () => boolean,
): ForwardBatchInput | null {
  const ids = [...selectedIds];
  if (action !== "delete") return { action, ids };
  return confirmDelete() ? { action, ids, confirm_delete: true } : null;
}

/** UI request fence; server RBAC is still the security boundary. */
export async function submitForwardBatch(
  input: ForwardBatchInput,
  deps: {
    current: () => boolean;
    verifyOwnership?: (id: number, action: "update" | "delete") => Promise<boolean>;
    deniedMessage: string;
    send: (input: ForwardBatchInput) => Promise<ForwardBatchResult>;
  },
): Promise<ForwardBatchResult | null> {
  if (!deps.current()) return null;
  if (deps.verifyOwnership) {
    const action = input.action === "delete" ? "delete" : "update";
    const allowed = await Promise.all(input.ids.map((id) => deps.verifyOwnership!(id, action)));
    if (!deps.current()) return null;
    if (allowed.some((value) => !value)) throw new Error(deps.deniedMessage);
  }
  if (!deps.current()) return null;
  const result = await deps.send(input);
  return deps.current() ? result : null;
}
