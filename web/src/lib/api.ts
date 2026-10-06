/**
 * Compatibility facade for TuneX Web API domains.
 */
export * from "./api/core";
import { workspacesApi } from "./api/workspaces";
import { authApi } from "./api/auth";
import { settingsApi } from "./api/settings";
import { dashboardApi } from "./api/dashboard";
import { announcementsApi } from "./api/announcements";
import { forwardsApi } from "./api/forwards";
import { nodesApi } from "./api/nodes";
import { nodeGroupsApi } from "./api/nodeGroups";
import { plansApi } from "./api/plans";
import { topupsApi } from "./api/topups";
import { ticketsApi } from "./api/tickets";
import { routeProfilesApi } from "./api/routeProfiles";
import { adminApi } from "./api/admin";

export const api = {
  workspaces: workspacesApi,
  auth: authApi,
  settings: settingsApi,
  dashboard: dashboardApi,
  announcements: announcementsApi,
  forwards: forwardsApi,
  nodes: nodesApi,
  nodeGroups: nodeGroupsApi,
  plans: plansApi,
  topups: topupsApi,
  tickets: ticketsApi,
  routeProfiles: routeProfilesApi,
  admin: adminApi,
};
