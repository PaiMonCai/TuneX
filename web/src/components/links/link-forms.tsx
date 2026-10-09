"use client";

import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import type { UserNode } from "@/lib/types";
import { isLinkTargetHost, LINK_TARGET_LIMIT, projectLinkClientSource, projectLinkTargetSet, type LinkClientSource, type LinkBindingInput, type LinkConfig, type LinkCreateInput, type LinkProtocol, type LinkTargetSet } from "@/lib/links-types";
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
  const protocol = fixedProtocol ?? data.get("protocol");
  const listen_host = data.get("listen_host");
  if (!name || name.length > 255 || !["tcp", "udp", "both"].includes(String(protocol))
    || !["", "127.0.0.1", "::1"].includes(String(listen_host))) throw new Error("invalid_input");
  const sourceEnabled = data.get("client_source_enabled");
  const sourcePresent = data.get("client_source_present");
  if ((sourceEnabled !== null && sourceEnabled !== "1") || (sourcePresent !== null && sourcePresent !== "1")) throw new Error("invalid_client_source");
  let clientSource: LinkClientSource | undefined;
  if (sourceEnabled === "1" || sourcePresent === "1") {
    if (protocol !== "tcp") throw new Error("client_source_tcp_only");
    try {
      const receive = data.get("receive_proxy");
      const trusted = data.get("trusted_cidrs");
      if (sourceEnabled === "1" && ((receive !== null && receive !== "1")
        || (trusted !== null && typeof trusted !== "string") || (receive === "1" && trusted === null))) throw new Error("invalid_client_source");
      clientSource = projectLinkClientSource(sourceEnabled === "1"
        ? { version: 1, receive_proxy: receive === "1", trusted_cidrs: String(trusted ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean), send_proxy: data.get("send_proxy") }
        : { version: 1, receive_proxy: false, trusted_cidrs: [], send_proxy: "off" });
    } catch { throw new Error("invalid_client_source"); }
  }
  const enabled = data.get("target_set_enabled");
  if (enabled === "1" && data.get("target_strategy") === "ip_hash" && (protocol !== "tcp" || !clientSource)) throw new Error("ip_hash_requires_client_source");
  if (enabled !== null && enabled !== "1") throw new Error("invalid_input");
  const hosts = data.getAll("target_host");
  const ports = data.getAll("target_port");
  if (!hosts.length || hosts.length > LINK_TARGET_LIMIT || hosts.length !== ports.length
    || (enabled === null && hosts.length !== 1)) throw new Error("invalid_input");
  const targets = hosts.map((host, index) => {
    const port = ports[index];
    if (typeof host !== "string" || typeof port !== "string" || !/^\d+$/.test(port)) throw new Error("invalid_input");
    const trimmed = host.trim();
    const value = Number(port);
    if (!isLinkTargetHost(trimmed)
      || !Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error("invalid_input");
    return { host: trimmed, port: value };
  });
  const targetSet = enabled === "1" ? projectLinkTargetSet({ version: 1, targets,
    strategy: data.get("target_strategy"), probe: data.get("target_probe"),
    failure_seconds: numeric(data, "target_failure_seconds", 10, 3600),
    recover_seconds: numeric(data, "target_recover_seconds", 10, 3600) }) : undefined;
  const { host: target_host, port: target_port } = targets[0];
  return { name, target_host, protocol: protocol as LinkBindingInput["protocol"], listen_host: listen_host as LinkBindingInput["listen_host"],
    target_port, ...(targetSet ? { target_set: targetSet } : {}), ...(clientSource ? { client_source: clientSource } : {}), listen_port: numeric(data, "listen_port", 1, 65_535),
    bytes_per_second_in: numeric(data, "bytes_per_second_in", 0, 2_147_483_647),
    bytes_per_second_out: numeric(data, "bytes_per_second_out", 0, 2_147_483_647),
    max_connections: numeric(data, "max_connections", 0, 1_000_000),
    max_connections_per_ip: numeric(data, "max_connections_per_ip", 0, 1_000_000) };
}

function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return <div className="grid gap-2"><Label htmlFor={id}>{label}</Label>{children}</div>;
}
function FormFooter({ copy, busy, onCancel, submitLabel = copy.save }: { copy: LinksCopy; busy: boolean; onCancel: () => void; submitLabel?: string }) {
  return <div className="flex flex-wrap justify-end gap-2">
    <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>{copy.cancel}</Button>
    <Button type="submit" disabled={busy}>{busy ? copy.working : submitLabel}</Button>
  </div>;
}

export function LinkConfigForm({ copy, nodes, nodesError, initial, busy, onCancel, onSubmit, submitLabel, ariaLabel, onInputChange }: {
  copy: LinksCopy; nodes: UserNode[]; nodesError: boolean; initial?: LinkConfig;
  busy: boolean; onCancel: () => void; onSubmit: (input: LinkCreateInput) => Promise<void>;
  submitLabel?: string; ariaLabel?: string; onInputChange?: () => void;
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
  return <form onSubmit={(e) => void submit(e)} onChange={onInputChange} className="space-y-4" aria-label={ariaLabel ?? (initial ? copy.edit : copy.create)}>
    <fieldset className="space-y-4" disabled={busy || nodesError || !ingress.length || !egress.length}>
      {!initial && <Field id={`${prefix}-name`} label={copy.name}><Input id={`${prefix}-name`} name="name" required maxLength={255} /></Field>}
      <div className="grid gap-4 sm:grid-cols-2">{nodeSelect("ingress", ingress)}{nodeSelect("egress", egress)}</div>
      <Field id={`${prefix}-carrier`} label={copy.carrierPort}><Input id={`${prefix}-carrier`} name="carrier_port" type="number" min={1} max={65_535} step={1} required defaultValue={initial?.carrier_port} aria-describedby={`${prefix}-hint`} /></Field>
      <p id={`${prefix}-hint`} className="text-sm text-[var(--muted-foreground)]">{copy.carrierHint}</p>
      <FormFooter copy={copy} busy={busy} onCancel={onCancel} submitLabel={submitLabel} />
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
  const [invalid, setInvalid] = useState<string | null>(null);
  const [protocol, setProtocol] = useState<LinkProtocol>(initial?.protocol ?? "tcp");
  const [sourceEnabled, setSourceEnabled] = useState(!!initial?.client_source);
  const [strategy, setStrategy] = useState<LinkTargetSet["strategy"]>(initial?.target_set?.strategy ?? "fallback");
  // Existing configs remain explicit even when the user switches all source features off.
  const sourceExplicit = sourceEnabled || !!initial?.client_source;
  const changeProtocol = (next: LinkProtocol) => {
    if (next !== "tcp" && (sourceExplicit || strategy === "ip_hash")) { setInvalid(copy.clientSourceTcpOnly); return; }
    setInvalid(null); setProtocol(next);
  };
  const changeSource = (enabled: boolean) => {
    if (!enabled && !initial?.client_source && strategy === "ip_hash") { setInvalid(copy.ipHashRequiresClientSource); return; }
    setInvalid(null); setSourceEnabled(enabled);
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setInvalid(null);
    let binding: LinkBindingInput;
    try {
      const data = new FormData(event.currentTarget);
      if (initial) data.set("listen_host", initial.listen_host);
      binding = parseLinkBindingForm(data, initial?.protocol);
    }
    catch (error) {
      const sourceErrors: Record<string, string> = { invalid_client_source: copy.sourceValidation,
        client_source_tcp_only: copy.clientSourceTcpOnly, ip_hash_requires_client_source: copy.ipHashRequiresClientSource };
      setInvalid((error instanceof Error ? sourceErrors[error.message] : null)
        ?? (new FormData(event.currentTarget).get("target_set_enabled") === "1" ? copy.targetsValidation : copy.validation));
      return;
    }
    await onSubmit(binding);
  };
  const num = (key: keyof LinkBindingInput, label: string, min: number, max: number, defaultValue?: number) =>
    <Field id={`${prefix}-${key}`} label={label}><Input id={`${prefix}-${key}`} name={key} type="number" min={min} max={max} step={1} required defaultValue={defaultValue} /></Field>;
  return <form onSubmit={(e) => void submit(e)} className="space-y-4" aria-label={initial ? copy.editForward : copy.addForward}>
    <fieldset disabled={busy} className="space-y-4">
      <Field id={`${prefix}-name`} label={copy.name}><Input id={`${prefix}-name`} name="name" required maxLength={255} defaultValue={initial?.name} /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${prefix}-protocol`} label={copy.protocol}><select id={`${prefix}-protocol`} name="protocol" className={selectClass} value={protocol} onChange={(e) => changeProtocol(e.target.value as LinkProtocol)} disabled={!!initial}>
          <option value="tcp">TCP</option><option value="udp">UDP</option><option value="both">TCP + UDP</option>
        </select></Field>
        {num("listen_port", copy.listenPort, 1, 65_535, initial?.listen_port)}
        <Field id={`${prefix}-scope`} label={copy.listenHost}><select id={`${prefix}-scope`} name="listen_host" className={selectClass} defaultValue={initial?.listen_host ?? ""} disabled={!!initial}>
          <option value="">{copy.wildcard}</option><option value="127.0.0.1">{copy.loopback4}</option><option value="::1">{copy.loopback6}</option>
        </select></Field>
      </div>
      {initial && <p className="text-sm text-[var(--muted-foreground)]">{copy.protocolLocked}</p>}
      <LinkSourceFields copy={copy} initial={initial?.client_source} protocol={protocol} enabled={sourceEnabled} onChange={changeSource} />
      <LinkTargetFields copy={copy} initial={initial} protocol={protocol} sourceExplicit={sourceExplicit} strategy={strategy} onStrategyChange={setStrategy} />
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
    {invalid && <p role="alert" className="text-sm text-[var(--destructive)]">{invalid}</p>}
  </form>;
}

function LinkSourceFields({ copy, initial, protocol, enabled, onChange }: {
  copy: LinksCopy; initial?: LinkClientSource; protocol: LinkProtocol; enabled: boolean; onChange: (value: boolean) => void;
}) {
  const prefix = useId();
  const [receive, setReceive] = useState(initial?.receive_proxy ?? false);
  return <fieldset className="space-y-3 rounded-md border border-[var(--border)] p-3">
    <legend className="px-1 text-sm font-medium">{copy.clientSourcePolicy}</legend>
    {initial && <input type="hidden" name="client_source_present" value="1" />}
    <label htmlFor={`${prefix}-enabled`} className="flex items-center gap-2 text-sm">
      <input id={`${prefix}-enabled`} name="client_source_enabled" type="checkbox" value="1" checked={enabled} disabled={protocol !== "tcp"} onChange={(e) => onChange(e.target.checked)} />
      {copy.clientSourceOptIn}
    </label>
    {protocol !== "tcp" && <p className="text-sm text-[var(--muted-foreground)]">{copy.clientSourceTcpOnly}</p>}
    {initial && <p className="text-sm text-[var(--muted-foreground)]">{copy.sourceKeepHint}</p>}
    {enabled && protocol === "tcp" && <>
      <label htmlFor={`${prefix}-receive`} className="flex items-center gap-2 text-sm">
        <input id={`${prefix}-receive`} name="receive_proxy" type="checkbox" value="1" checked={receive} onChange={(e) => setReceive(e.target.checked)} aria-describedby={`${prefix}-receive-hint`} />
        {copy.receiveProxy}
      </label>
      <Field id={`${prefix}-trusted`} label={copy.trustedCidrs}>
        <textarea id={`${prefix}-trusted`} name="trusted_cidrs" rows={3} required={receive} disabled={!receive} defaultValue={initial?.trusted_cidrs.join("\n") ?? ""}
          className="min-h-24 w-full rounded-md border border-[var(--input)] bg-[var(--card)] px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]" aria-describedby={`${prefix}-trusted-hint`} />
      </Field>
      <p id={`${prefix}-trusted-hint`} className="text-sm text-[var(--muted-foreground)]">{copy.sourceValidation}</p>
      <p id={`${prefix}-receive-hint`} className="text-sm text-[var(--muted-foreground)]">{copy.sourceReceiveHint}</p>
      <Field id={`${prefix}-send`} label={copy.sendProxy}>
        <select id={`${prefix}-send`} name="send_proxy" className={selectClass} defaultValue={initial?.send_proxy ?? "off"} aria-describedby={`${prefix}-send-hint`}>
          <option value="off">{copy.sendProxyOff}</option><option value="v1">PROXY v1</option><option value="v2">PROXY v2</option>
        </select>
      </Field>
      <p id={`${prefix}-send-hint`} className="text-sm text-[var(--muted-foreground)]">{copy.sourceSendHint}</p>
      <p className="text-sm text-[var(--muted-foreground)]">{copy.sourceSocketHint}</p>
    </>}
    <p className="text-sm text-[var(--muted-foreground)]">{copy.sourcePolicyHint}</p>
  </fieldset>;
}

function LinkTargetFields({ copy, initial, protocol, sourceExplicit, strategy, onStrategyChange }: {
  copy: LinksCopy; initial?: LinkBindingInput; protocol: LinkProtocol; sourceExplicit: boolean;
  strategy: LinkTargetSet["strategy"]; onStrategyChange: (strategy: LinkTargetSet["strategy"]) => void;
}) {
  const prefix = useId();
  const [enabled, setEnabled] = useState(!!initial?.target_set);
  const [targets, setTargets] = useState(() => (initial?.target_set?.targets
    ?? [{ host: initial?.target_host ?? "", port: initial?.target_port }]).map((target, id) => ({ id, host: target.host, port: String(target.port ?? "") })));
  const nextId = useRef(LINK_TARGET_LIMIT);
  // null follows protocol defaults; an explicit user choice or stored probe is preserved.
  const [probe, setProbe] = useState<LinkTargetSet["probe"] | null>(initial?.target_set?.probe ?? null);
  const selectedProbe = probe ?? (protocol === "udp" ? "none" : "tcp");
  const move = (index: number, delta: number) => setTargets((rows) => {
    const result = [...rows];
    [result[index], result[index + delta]] = [result[index + delta], result[index]];
    return result;
  });
  const update = (id: number, field: "host" | "port", value: string) => setTargets((rows) => rows.map((row) => row.id === id ? { ...row, [field]: value } : row));
  return <fieldset className="space-y-3 rounded-md border border-[var(--border)] p-3">
    <legend className="px-1 text-sm font-medium">{copy.targets}</legend>
    <label htmlFor={`${prefix}-enabled`} className="flex items-center gap-2 text-sm">
      <input id={`${prefix}-enabled`} name="target_set_enabled" type="checkbox" value="1" checked={enabled} disabled={!!initial?.target_set} onChange={(e) => setEnabled(e.target.checked)} />
      {copy.targetsOptIn}
    </label>
    {initial?.target_set && <><input type="hidden" name="target_set_enabled" value="1" /><p className="text-sm text-[var(--muted-foreground)]">{copy.targetsKeepSetHint}</p></>}
    <p id={`${prefix}-hint`} className="text-sm text-[var(--muted-foreground)]">{enabled ? copy.targetsHint : copy.targetsLegacyHint}</p>
    <p className="text-sm text-[var(--muted-foreground)]">{copy.targetAddressHint}</p>
    <ol className="space-y-3" aria-label={copy.targets}>
      {(enabled ? targets : targets.slice(0, 1)).map((target, index) => <li key={target.id} data-target-index={index} className="space-y-2 rounded-md border border-[var(--border)] p-3">
        <p className="text-sm font-medium">{copy.targetIndex} {index}{index === 0 ? ` · ${copy.targetFirst}` : ""}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${prefix}-${target.id}-host`} label={`${copy.targetHost} (${index})`}>
            <Input id={`${prefix}-${target.id}-host`} name="target_host" maxLength={255} required value={target.host} onChange={(e) => update(target.id, "host", e.target.value)} aria-describedby={`${prefix}-hint`} />
          </Field>
          <Field id={`${prefix}-${target.id}-port`} label={`${copy.targetPort} (${index})`}>
            <Input id={`${prefix}-${target.id}-port`} name="target_port" type="number" min={1} max={65_535} step={1} required value={target.port} onChange={(e) => update(target.id, "port", e.target.value)} />
          </Field>
        </div>
        {enabled && <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" aria-label={`${copy.moveTargetUp} (${index})`} disabled={index === 0} onClick={() => move(index, -1)}>{copy.moveTargetUp}</Button>
          <Button type="button" variant="outline" size="sm" aria-label={`${copy.moveTargetDown} (${index})`} disabled={index === targets.length - 1} onClick={() => move(index, 1)}>{copy.moveTargetDown}</Button>
          <Button type="button" variant="outline" size="sm" aria-label={`${copy.removeTarget} (${index})`} disabled={targets.length === 1} onClick={() => setTargets((rows) => rows.filter((row) => row.id !== target.id))}>{copy.removeTarget}</Button>
        </div>}
      </li>)}
    </ol>
    {enabled && <>
      <Button type="button" variant="outline" disabled={targets.length >= LINK_TARGET_LIMIT} onClick={() => {
        const id = nextId.current++;
        setTargets((rows) => [...rows, { id, host: "", port: "" }]);
      }}>{copy.addTarget} ({targets.length}/{LINK_TARGET_LIMIT})</Button>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${prefix}-strategy`} label={copy.targetStrategy}>
          <select id={`${prefix}-strategy`} name="target_strategy" className={selectClass} value={strategy} onChange={(e) => onStrategyChange(e.target.value as LinkTargetSet["strategy"])} aria-describedby={`${prefix}-strategy-hint`}>
            <option value="fallback">{copy.strategyFallback}</option><option value="round_robin">{copy.strategyRoundRobin}</option><option value="random">{copy.strategyRandom}</option>
            <option value="ip_hash" disabled={protocol !== "tcp" || !sourceExplicit}>{copy.strategyIpHash}</option>
          </select>
        </Field>
        <Field id={`${prefix}-probe`} label={copy.targetProbe}>
          <select id={`${prefix}-probe`} name="target_probe" className={selectClass} value={selectedProbe} onChange={(e) => setProbe(e.target.value as LinkTargetSet["probe"])} aria-describedby={`${prefix}-probe-hint`}>
            <option value="tcp">{protocol === "udp" ? copy.probeTcpAuxiliary : copy.probeTcp}</option><option value="none">{copy.probeNone}</option>
          </select>
        </Field>
        <Field id={`${prefix}-failure`} label={copy.targetFailureSeconds}>
          <Input id={`${prefix}-failure`} name="target_failure_seconds" type="number" min={10} max={3600} step={1} required defaultValue={initial?.target_set?.failure_seconds ?? 30} />
        </Field>
        <Field id={`${prefix}-recover`} label={copy.targetRecoverSeconds}>
          <Input id={`${prefix}-recover`} name="target_recover_seconds" type="number" min={10} max={3600} step={1} required defaultValue={initial?.target_set?.recover_seconds ?? 30} />
        </Field>
      </div>
      <p id={`${prefix}-strategy-hint`} className="text-sm text-[var(--muted-foreground)]">{copy.ipHashHint}</p>
      {strategy === "ip_hash" && <p className="text-sm text-[var(--muted-foreground)]">{copy.ipHashRemapHint}</p>}
      <p className="text-sm text-[var(--muted-foreground)]">{copy.targetWindowsHint}</p>
      <p id={`${prefix}-probe-hint`} className="text-sm text-[var(--muted-foreground)]">{copy.targetProbeHint}</p>
    </>}
    {(protocol === "udp" || protocol === "both") && <p className="text-sm text-[var(--muted-foreground)]">{copy.udpProbeHint}</p>}
  </fieldset>;
}
