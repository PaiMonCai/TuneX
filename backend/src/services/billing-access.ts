/** Payment writes are opt-in and must never be used to decide RBAC. */
export function isBillingBlocked(pathname: string, method: string, enabled: boolean): boolean {
  if (enabled) return false;
  const path = pathname.replace(/\/+$/, "") || "/";
  const inArea = (prefix: string) => path === prefix || path.startsWith(prefix + "/");
  if (/^\/api\/pay\/[^/]+\/callback$/.test(path)) return true;
  if (method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD") return false;
  return inArea("/api/pay") || inArea("/api/topups") || path === "/api/plans/purchase" ||
    inArea("/api/admin/pay") || inArea("/api/admin/payments") || inArea("/api/admin/topup");
}
