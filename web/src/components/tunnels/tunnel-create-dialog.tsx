"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { TUNNEL_TYPES } from "@/lib/constants";
import type { NodeGroup, TunnelCreateInput, TunnelType } from "@/lib/types";

export function TunnelCreateDialog({
  open,
  onOpenChange,
  nodeGroups,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  nodeGroups: NodeGroup[];
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<TunnelType>("tcp");
  const [category, setCategory] = useState<"port_forward" | "remote_port_forward">("port_forward");
  const [inGroup, setInGroup] = useState("");
  const [forward, setForward] = useState("");
  const [port, setPort] = useState("");

  useEffect(() => {
    if (open && !inGroup && nodeGroups.length > 0) setInGroup(String(nodeGroups[0].id));
  }, [open, nodeGroups, inGroup]);

  async function submit() {
    if (!name || !inGroup || !forward.trim()) {
      toast.error(t("tunnel.createFailed"));
      return;
    }
    setPending(true);
    try {
      await api.tunnels.create({
        name,
        tunnel_type: type,
        category,
        in_node_group_id: Number(inGroup),
        forward_addresses: forward.split("\n").map((s) => s.trim()).filter(Boolean),
        listen_port: port ? Number(port) : null,
      } as TunnelCreateInput);
      toast.success(t("tunnel.createSuccess"));
      setName("");
      setForward("");
      setPort("");
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("tunnel.createFailed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="tunnel-create-dialog">
        <DialogHeader>
          <DialogTitle>{t("tunnel.createTitle")}</DialogTitle>
          <DialogDescription>{t("tunnel.createDesc")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Field label={t("tunnel.name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-tunnel" />
          </Field>
          <Field label={t("tunnel.tunnelType")}>
            <Select value={type} onValueChange={(v) => setType(v as TunnelType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TUNNEL_TYPES.map((tt) => (
                  <SelectItem key={tt} value={tt}>
                    {tt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("tunnel.category")}>
            <Select value={category} onValueChange={(v) => setCategory(v as "port_forward" | "remote_port_forward")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="port_forward">{t("tunnel.portForward")}</SelectItem>
                <SelectItem value="remote_port_forward">{t("tunnel.remotePortForward")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("tunnel.inNodeGroup")}>
            <Select value={inGroup} onValueChange={setInGroup}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {nodeGroups.map((g) => (
                  <SelectItem key={g.id} value={String(g.id)}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("tunnel.forwardAddresses")} hint={t("tunnel.forwardAddressesHint")}>
            <Textarea value={forward} onChange={(e) => setForward(e.target.value)} rows={3} />
          </Field>
          <Field label={t("tunnel.listenPort")} hint={t("tunnel.listenPortHint")}>
            <Input value={port} onChange={(e) => setPort(e.target.value)} placeholder="20001" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={pending}>
            {t("tunnel.createButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-[var(--muted-foreground)]">{hint}</p>}
    </div>
  );
}
