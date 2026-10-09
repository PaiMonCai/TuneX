import { ApiError, request } from "@/lib/api/core";
import { projectLinkDetail, projectLinkList, projectLinkResource, type LinkBindingInput,
  type LinkConfig, type LinkCreateInput, type LinkForwardAction, LinksPayloadError } from "./links-types";
import { projectLinkMaintenanceInput, projectLinkMaintenancePreview, type LinkMaintenancePreviewInput } from "./link-maintenance-types";

function matchingId<T extends { id: number }>(value: T, expectedId: number): T {
  if (value.id !== expectedId) throw new LinksPayloadError();
  return value;
}

/** Uses the shared session, CSRF, error and Workspace transport; never the global scope implicitly. */
export const linksApi = {
  list: async (workspaceId: number) => projectLinkList(await request<unknown>("/links", { workspaceId }), workspaceId),
  detail: async (workspaceId: number, id: number) => matchingId(projectLinkDetail(await request<unknown>(`/links/${id}`, { workspaceId }), workspaceId), id),
  previewMaintenance: async (workspaceId: number, id: number, raw: LinkMaintenancePreviewInput) => {
    if (![workspaceId, id].every((v) => Number.isSafeInteger(v) && v > 0 && v <= 2_147_483_647)) throw new LinksPayloadError();
    const input = projectLinkMaintenanceInput(raw);
    return projectLinkMaintenancePreview(await request<unknown>(`/links/${id}/maintenance/preview`, {
      method: "POST", workspaceId, body: input, cache: "no-store",
    }), workspaceId, id, input);
  },
  create: async (workspaceId: number, input: LinkCreateInput) => projectLinkResource(
    await request<unknown>("/links", { method: "POST", workspaceId, body: input }), workspaceId),
  updateConfig: async (workspaceId: number, id: number, expected_version: number, config: LinkConfig) => matchingId(projectLinkResource(
    await request<unknown>(`/links/${id}/config`, { method: "PUT", workspaceId, body: { expected_version, config } }), workspaceId), id),
  deploy: async (workspaceId: number, id: number) => matchingId(projectLinkDetail(
    await request<unknown>(`/links/${id}/deploy`, { method: "POST", workspaceId }), workspaceId), id),
  rotateKey: async (workspaceId: number, id: number) => matchingId(projectLinkDetail(
    await request<unknown>(`/links/${id}/rotate-key`, { method: "POST", workspaceId }), workspaceId), id),
  retire: async (workspaceId: number, id: number) => {
    const result = await request<{ id: number; status: string }>(`/links/${id}`, { method: "DELETE", workspaceId });
    if (!result || result.id !== id || result.status !== "retired") throw new LinksPayloadError();
    return result;
  },
  createForward: async (workspaceId: number, id: number, binding: LinkBindingInput) => {
    const result = await request<{ id: number; link_id: number }>(`/links/${id}/forwards`, { method: "POST", workspaceId, body: binding });
    if (!result || !Number.isSafeInteger(result.id) || result.id <= 0 || result.link_id !== id) throw new LinksPayloadError();
    return { id: result.id, link_id: result.link_id };
  },
  updateForward: async (workspaceId: number, id: number, forwardId: number, expected_revision: number, binding: LinkBindingInput) => matchingId(projectLinkDetail(
    await request<unknown>(`/links/${id}/forwards/${forwardId}`, { method: "PUT", workspaceId,
      body: { expected_revision, binding } }), workspaceId), id),
  actionForward: async (workspaceId: number, id: number, forwardId: number, action: LinkForwardAction) => matchingId(projectLinkDetail(
    await request<unknown>(`/links/${id}/forwards/${forwardId}/actions`, { method: "POST", workspaceId,
      body: { action } }), workspaceId), id),
};

export interface LinkErrorInfo { code: string; conflict: boolean; disabled: boolean; denied: boolean }
/** Only display safe machine codes; raw errors may contain internal configuration. */
export function linkErrorInfo(error: unknown): LinkErrorInfo {
  const data = error instanceof ApiError && error.data && typeof error.data === "object"
    ? error.data as Record<string, unknown> : null;
  const raw = data?.code ?? (error && typeof error === "object" && "code" in error ? error.code : null);
  const code = typeof raw === "string" && /^[a-z][a-z0-9_]{0,95}$/.test(raw) ? raw
    : error instanceof ApiError && error.status === 403 ? "permission_denied" : "link_request_failed";
  return { code, conflict: ["revision_conflict", "link_version_conflict", "link_generation_conflict"].includes(code),
    disabled: code === "fxp_links_not_enabled", denied: error instanceof ApiError && [401, 403].includes(error.status) };
}
