"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import type { UserNode } from "@/lib/types";
import type { LinkBindingInput, LinkConfig, LinkCreateInput } from "@/lib/links-types";
import type { LinksCopy } from "./links-copy";

export const selectClass = "h-9 w-full rounded-md border border-[var(--input)] bg-[var(--card)] px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]";
function numeric(data: FormData, key: string, min: number, max: number): number {
  const raw = data.get(key);
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) throw new Error("invalid_input");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("invalid_input");
  return value;
}
export function parseLinkConfigForm(data: FormData): LinkConfig {
  const config = { ingress_node_id: numeric(data, "ingress_node_id", 1, 2_147_483_647),
    egress_node_id: numeric(data, "egress_node_id", 1, 2_147_483_647),
    carrier_port: numeric(data, "carrier_port", 1, 65_535) };
  if (config.ingress_node_id === config.egress_node_id) throw new Error("invalid_input");
  return config;
}
export function parseLinkBindingForm(data: FormData, fixedProtocol?: LinkBindingInput["protocol"]): LinkBindingInput {
  const name = String(data.get("name") ?? "").trim();
  const target_host = String(data.get("target_host") ?? "").trim();
  const protocol = fixedProtocol ?? data.get("protocol");
  const listen_host = data.get("listen_host");
  if (!name || name.length > 255 || !target_host || target_host.length > 255 || /[\s/\x00]/.test(target_host)
    || !["tcp", "udp", "both"].includes(String(protocol)) || !["", "127.0.0.1", "::1"].includes(String(listen_host))) throw new Error("invalid_input");
  return { name, target_host, protocol: protocol as LinkBindingInput["protocol"], listen_host: listen_host as LinkBindingInput["listen_host"],
    listen_port: numeric(data, "listen_port", 1, 65_535), target_port: numeric(data, "target_port", 1, 65_535),
    bytes_per_second_in: numeric(data, "bytes_per_second_in", 0, 2_147_483_647),
    bytes_per_second_out: numeric(data, "bytes_per_second_out", 0, 2_147_483_647),
    max_connections: numeric(data, "max_connections", 0, 1_000_000),
    max_connections_per_ip: numeric(data, "max_connections_per_ip", 0, 1_000_000) };
}

function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return <div className="grid gap-2"><Label htmlFor={id}>{label}</Label>{children}</div>;
}
function FormFooter({ copy, busy, onCancel }: { copy: LinksCopy; busy: boolean; onCancel: () => void }) {
  return <div className="flex flex-wrap justify-end gap-2">
    <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>{copy.cancel}</Button>
    <Button type="submit" disabled={busy}>{busy ? copy.working : copy.save}</Button>
  </div>;
}

export function LinkConfigForm({ copy, nodes, nodesError, initial, busy, onCancel, onSubmit }: {
  copy: LinksCopy; nodes: UserNode[]; nodesError: boolean; initial?: LinkConfig;
  busy: boolean; onCancel: () => void; onSubmit: (input: LinkCreateInput) => Promise<void>;
}) {
  const prefix = useId();
  const [invalid, setInvalid] = useState(false);
  const eligible = nodes.filter((n) => n.lifecycle === "active" && n.accepts_new_business !== false);
  const ingress = eligible.filter((n) => ["ingress", "both"].includes(n.role ?? ""));
  const egress = eligible.filter((n) => ["egress", "both"].includes(n.role ?? ""));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setInvalid(false);
    const data = new FormData(event.currentTarget);
    let input: LinkCreateInput;
    try {
      const name = initial ? "existing" : String(data.get("name") ?? "").trim();
      if (!name || name.length > 255) throw new Error("invalid_input");
      input = { name, config: parseLinkConfigForm(data) };
    } catch { setInvalid(true); return; }
    await onSubmit(input);
  };
  const nodeSelect = (role: "ingress" | "egress", rows: UserNode[]) => <Field id={`${prefix}-${role}`} label={role === "ingress" ? copy.ingress : copy.egress}>
    <select id={`${prefix}-${role}`} name={`${role}_node_id`} className={selectClass} required defaultValue={initial?.[`${role}_node_id`] ?? ""}>
      <option value="" disabled>{copy.chooseNode}</option>
      {rows.map((node) => <option key={node.id} value={node.id}>{node.node_id}{node.connect_ip ? ` · ${node.connect_ip}` : ""}</option>)}
    </select>
  </Field>;
  return <form onSubmit={(e) => void submit(e)} className="space-y-4" aria-label={initial ? copy.edit : copy.create}>
    <fieldset className="space-y-4" disabled={busy || nodesError || !ingress.length || !egress.length}>
      {!initial && <Field id={`${prefix}-name`} label={copy.name}><Input id={`${prefix}-name`} name="name" required maxLength={255} /></Field>}
      <div className="grid gap-4 sm:grid-cols-2">{nodeSelect("ingress", ingress)}{nodeSelect("egress", egress)}</div>
      <Field id={`${prefix}-carrier`} label={copy.carrierPort}><Input id={`${prefix}-carrier`} name="carrier_port" type="number" min={1} max={65_535} step={1} required defaultValue={initial?.carrier_port} aria-describedby={`${prefix}-hint`} /></Field>
      <p id={`${prefix}-hint`} className="text-sm text-[var(--muted-foreground)]">{copy.carrierHint}</p>
      <FormFooter copy={copy} busy={busy} onCancel={onCancel} />
    </fieldset>
    {(nodesError || !ingress.length || !egress.length) && <p role="alert">{nodesError ? copy.nodesFailed : copy.noNodes}</p>}
    {invalid && <p role="alert" className="text-sm text-[var(--destructive)]">{copy.validation}</p>}
    {(nodesError || !ingress.length || !egress.length) && <Button variant="outline" type="button" onClick={onCancel}>{copy.cancel}</Button>}
  </form>;
}

export function LinkBindingForm({ copy, initial, busy, onCancel, onSubmit }: {
  copy: LinksCopy; initial?: LinkBindingInput; busy: boolean;
  onCancel: () => void; onSubmit: (binding: LinkBindingInput) => Promise<void>;
}) {
  const prefix = useId();
  const [invalid, setInvalid] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setInvalid(false);
    let binding: LinkBindingInput;
    try {
      const data = new FormData(event.currentTarget);
      if (initial) data.set("listen_host", initial.listen_host);
      binding = parseLinkBindingForm(data, initial?.protocol);
    }
    catch { setInvalid(true); return; }
    await onSubmit(binding);
  };
  const num = (key: keyof LinkBindingInput, label: string, min: number, max: number, defaultValue?: number) =>
    <Field id={`${prefix}-${key}`} label={label}><Input id={`${prefix}-${key}`} name={key} type="number" min={min} max={max} step={1} required defaultValue={defaultValue} /></Field>;
  return <form onSubmit={(e) => void submit(e)} className="space-y-4" aria-label={initial ? copy.editForward : copy.addForward}>
    <fieldset disabled={busy} className="space-y-4">
      <Field id={`${prefix}-name`} label={copy.name}><Input id={`${prefix}-name`} name="name" required maxLength={255} defaultValue={initial?.name} /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${prefix}-protocol`} label={copy.protocol}><select id={`${prefix}-protocol`} name="protocol" className={selectClass} defaultValue={initial?.protocol ?? "tcp"} disabled={!!initial}>
          <option value="tcp">TCP</option><option value="udp">UDP</option><option value="both">TCP + UDP</option>
        </select></Field>
        {num("listen_port", copy.listenPort, 1, 65_535, initial?.listen_port)}
        <Field id={`${prefix}-scope`} label={copy.listenHost}><select id={`${prefix}-scope`} name="listen_host" className={selectClass} defaultValue={initial?.listen_host ?? ""} disabled={!!initial}>
          <option value="">{copy.wildcard}</option><option value="127.0.0.1">{copy.loopback4}</option><option value="::1">{copy.loopback6}</option>
        </select></Field>
        <Field id={`${prefix}-target`} label={copy.targetHost}><Input id={`${prefix}-target`} name="target_host" maxLength={255} required defaultValue={initial?.target_host} /></Field>
        {num("target_port", copy.targetPort, 1, 65_535, initial?.target_port)}
      </div>
      {initial && <p className="text-sm text-[var(--muted-foreground)]">{copy.protocolLocked}</p>}
      <fieldset className="space-y-3 rounded-md border border-[var(--border)] p-3">
        <legend className="px-1 text-sm font-medium">{copy.limits}</legend>
        <p className="text-sm text-[var(--muted-foreground)]">{copy.limitHint}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {num("bytes_per_second_in", copy.rateIn, 0, 2_147_483_647, initial?.bytes_per_second_in ?? 0)}
          {num("bytes_per_second_out", copy.rateOut, 0, 2_147_483_647, initial?.bytes_per_second_out ?? 0)}
          {num("max_connections", copy.connections, 0, 1_000_000, initial?.max_connections ?? 0)}
          {num("max_connections_per_ip", copy.perIp, 0, 1_000_000, initial?.max_connections_per_ip ?? 0)}
        </div>
      </fieldset>
      <p className="text-sm text-[var(--muted-foreground)]">{copy.updateHint}</p>
      <FormFooter copy={copy} busy={busy} onCancel={onCancel} />
    </fieldset>
    {invalid && <p role="alert" className="text-sm text-[var(--destructive)]">{copy.validation}</p>}
  </form>;
}
