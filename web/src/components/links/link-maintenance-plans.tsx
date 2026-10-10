"use client";

import { useEffect, useRef, useState } from "react";
import { linksApi, linkErrorInfo, type LinkErrorInfo } from "@/lib/links-api";
import type { LinkMaintenanceMigration } from "@/lib/link-maintenance-migrations";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { LinkErrorDetails } from "./link-error-details";
import type { LinksCopy } from "./links-copy";

/** Scoped closed intent metadata; does not infer candidate Ready or execute migration. */
export function LinkMaintenancePlans({ workspaceId, linkId, epoch, now, copy, canManage, busy, onPendingChange, onCancel }: {
  workspaceId: number; linkId: number; epoch: number; now: number; copy: LinksCopy; canManage: boolean; busy: boolean;
  onPendingChange: (pending: boolean) => void; onCancel: (row: LinkMaintenanceMigration) => Promise<boolean>;
}) {
  const sequence = useRef(0);
  const [plans, setPlans] = useState<LinkMaintenanceMigration[] | null>(null);
  const [error, setError] = useState<LinkErrorInfo | null>(null);
  useEffect(() => {
    const ticket = ++sequence.current;
    setError(null);
    void linksApi.listMaintenance(workspaceId, linkId).then((rows) => {
      if (sequence.current === ticket) setPlans(rows);
    }, (failure) => {
      if (sequence.current === ticket) { setPlans(null); setError(linkErrorInfo(failure)); }
    });
    return () => { sequence.current++; };
  }, [workspaceId, linkId, epoch]);
  const pending = plans?.some((row) => row.status === "awaiting_executor" && Date.parse(row.hold_expires_at) > now) ?? false;
  useEffect(() => { onPendingChange(pending); }, [pending, onPendingChange]);
  useEffect(() => () => onPendingChange(false), [onPendingChange]);
  const labels = { awaiting_executor: copy.maintenancePlanPending, cancelled: copy.maintenancePlanCancelled,
    invalidated: copy.maintenancePlanInvalidated, expired: copy.maintenancePlanExpired };
  return <Card><CardHeader><CardTitle>{copy.maintenancePlans}</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
    <p>{copy.maintenancePlanHint}</p><p>{copy.maintenancePlanNoExecution}</p>
    {error ? <div role="alert"><p>{copy.maintenancePlanFailed}</p><LinkErrorDetails codes={[error.code]} copy={copy} /></div>
      : plans === null ? <p role="status">{copy.maintenancePlanLoading}</p>
        : plans.length === 0 ? <p>{copy.maintenancePlanEmpty}</p> : <ul className="space-y-3">{plans.map((row) => <li key={row.id} className="rounded-md border p-3">
          <p>#{row.id} · {labels[row.status]} · {copy.revision}: {row.state_version}</p>
          <p>{row.operation === "rotate_key" ? copy.previewKey : copy.previewEndpoints} · {copy.refs}: {row.references.total}</p>
          <p>{copy.maintenancePlanExpires}: <time dateTime={row.hold_expires_at}>{row.hold_expires_at}</time></p>
          {row.reason_code && <LinkErrorDetails codes={[row.reason_code]} copy={copy} />}
          {canManage && row.status === "awaiting_executor" && <Button type="button" variant="outline" disabled={busy}
            onClick={() => void onCancel(row)}>{copy.maintenancePlanCancel}</Button>}
        </li>)}</ul>}
  </CardContent></Card>;
}
