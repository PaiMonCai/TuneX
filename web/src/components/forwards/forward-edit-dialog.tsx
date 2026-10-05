"use client";

/**
 * V4-WP4：Forward 全字段编辑器。
 *
 * 设计约束（全部来自 DEVELOPMENT.md §13.3）：
 *  · 字段集 = 创建表单字段集（§13.3.1「创建后可全编辑」）——测试按源码断言，
 *    不允许悄悄退回「只能改名」。
 *  · 保存只发**一个** PATCH（§13.3.3「禁止把一次编辑拆成多个独立 PATCH」），
 *    字段变更后重新计算 patch，而不是分步落库。
 *  · 影响面一律来自 `POST /:id/preview`（§13.3.3 单一实现），前端不自己推导
 *    rollout 规则；这里只做「空值 / 端口范围」这类形态预检，少发无效请求。
 *  · `expected_revision` 取打开编辑器时的 `config_revision`（desired 指针），
 *    不是 `applied_revision`——否则永远打不中并发闸门。
 *
 * V5-WP5-A1：编辑器**不改协议**（后端 `ForwardPatchSchema` 不接受 `protocol` /
 * `tls_*`），只读展示当前协议；协议徽标的唯一实现见
 * `components/forwards/forward-protocol-badge.tsx`。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Copy, Info, Link2, Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { api, getActiveWorkspace } from "@/lib/api";
import { useWorkspace } from "@/components/workspace/workspace-context";
import { useI18n } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import {
  listenPortHintKey,
  listenPortPlaceholderKey,
  type ForwardDraft,
} from "@/components/forwards/forward-copy";
import { bindingUsageView } from "@/components/forwards/forward-binding-usage";
import { ForwardProtocolBadge } from "@/components/forwards/forward-protocol-badge";
import {
  FORWARD_TLS_PATH_MAX,
  TLS_FORWARD_PROTOCOL,
  forwardProtocolFact,
  forwardProtocolNote,
  forwardProtocolPatchFields,
  forwardTransportFor,
  isForwardProtocol,
  tlsPathFieldErrors,
  type TlsPathFieldErrors,
} from "@/lib/forward-protocol";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/form";
import { Input, Label } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ForwardPatchInput, NodeBinding, PortForward, UserNode } from "@/lib/types";

/**
 * 编辑字段集常量——报告 §4.3 的「编辑 = 创建字段集」约束由源码与测试双向固化：
 * 任何字段从这里消失，`forward-edit-dialog.test.ts` 的字段集断言会失败。
 */
export const FORWARD_EDIT_FIELDS = [
  "name",
  "mode",
  "ingress_node_id",
  "egress_node_id",
  "listen_port",
  "target_host",
  "target_port",
] as const;

export type ForwardEditField = (typeof FORWARD_EDIT_FIELDS)[number];

/**
 * 编辑器草稿形状。V4-WP9 起复用 `forward-copy.ts` 的 {@link ForwardDraft}：
 * 复制出的草稿必须能直接落进同一个编辑器（字段集完全相同），因此这里不再另立一份
 * 结构上等价、却可能悄悄漂移的本地类型。
 *
 * V5-WP5-A1：草稿额外带 tls 的证书/私钥路径 —— 这两列现在**可编辑**
 * （后端 patch schema 已接受，规则与创建相同：只有 tls 能带、必须成对）。
 * 协议本身仍在 `forward` 上（只读），所以草稿里没有 `protocol`：草稿里放一个永远
 * 不会被保存的字段，就是让人以为能改的地方。
 */
type Draft = ForwardDraft & { tlsCertPath: string; tlsKeyPath: string };

const EMPTY_DRAFT: Draft = {
  name: "",
  mode: "direct",
  ingressId: "",
  egressId: "",
  listenPort: "",
  targetHost: "",
  targetPort: "",
  tlsCertPath: "",
  tlsKeyPath: "",
};

function draftFrom(forward: PortForward): Draft {
  return {
    name: forward.name ?? "",
    mode: forward.mode === "relay" ? "relay" : "direct",
    ingressId: forward.ingress_node_id ? String(forward.ingress_node_id) : "",
    egressId: forward.egress_node_id ? String(forward.egress_node_id) : "",
    listenPort: forward.listen_port != null ? String(forward.listen_port) : "",
    targetHost: forward.target_host ?? "",
    targetPort: forward.target_port != null ? String(forward.target_port) : "",
    // 只有 tls 行会渲染这两个输入；非 tls 行在视图里就是 null（= 空串，永不发出）。
    tlsCertPath: forward.tls_cert_path ?? "",
    tlsKeyPath: forward.tls_key_path ?? "",
  };
}

/**
 * Draft → patch：只包含用户实际改动的字段（未改的不发，让后端沿用当前 desired）。
 * `listen_port` 空串显式映射为 `null`（= 自动分配），与创建表单同义。
 *
 * V5-WP5-A1：tls 路径经 `forwardProtocolPatchFields()` 生成 —— 只有 tls 行会带上，
 * 且只在真的改了、且非空时出现（空串会让后端 zod 的 `.min(1)` 直接 400；
 * 「清空路径」是表单预检的失败，不是一次可提交的编辑）。
 */
export function draftToPatch(forward: PortForward, draft: Draft): ForwardPatchInput {
  const patch: ForwardPatchInput = {};
  if (draft.name.trim() !== (forward.name ?? "")) patch.name = draft.name.trim();
  if (draft.mode !== (forward.mode === "relay" ? "relay" : "direct")) {
    patch.mode = draft.mode;
  }
  const ingress = Number(draft.ingressId);
  if (Number.isInteger(ingress) && ingress > 0 && ingress !== Number(forward.ingress_node_id)) {
    patch.ingress_node_id = ingress;
  }
  const egress = draft.egressId ? Number(draft.egressId) : null;
  if (draft.mode === "relay") {
    if (egress !== null && egress !== Number(forward.egress_node_id)) patch.egress_node_id = egress;
  } else if (forward.egress_node_id != null) {
    // direct 必须清空出口（mode_topology_mismatch）
    patch.egress_node_id = null;
  }
  const listen = draft.listenPort.trim() ? Number(draft.listenPort.trim()) : null;
  if (listen !== (forward.listen_port ?? null)) patch.listen_port = listen;
  const host = draft.targetHost.trim() || null;
  if (host !== (forward.target_host ?? null)) patch.target_host = host;
  const port = draft.targetPort.trim() ? Number(draft.targetPort.trim()) : null;
  if (port !== (forward.target_port ?? null)) patch.target_port = port;
  // tls 路径：只有 tls 行、只有真的改了、且非空时才出现（见 forwardProtocolPatchFields）。
  Object.assign(
    patch,
    forwardProtocolPatchFields(
      forward.protocol,
      { cert: forward.tls_cert_path, key: forward.tls_key_path },
      { cert: draft.tlsCertPath ?? "", key: draft.tlsKeyPath ?? "" },
    ),
  );
  return patch;
}

/** 形态预检：只挡明显的空值/越界，语义判定交给 preview（§13.3.3 单一实现）。 */
export function draftFormErrors(
  draft: Draft,
  t: (key: string) => string,
): Partial<Record<ForwardEditField, string>> {
  const errors: Partial<Record<ForwardEditField, string>> = {};
  if (!draft.name.trim()) errors.name = t("forward.saveFailed");
  if (!draft.ingressId) errors.ingress_node_id = t("forward.chooseIngress");
  const listen = draft.listenPort.trim();
  if (listen && (!Number.isInteger(Number(listen)) || Number(listen) < 1 || Number(listen) > 65535)) {
    errors.listen_port = t("forward.saveFailed");
  }
  const port = draft.targetPort.trim();
  if (port && (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535)) {
    errors.target_port = t("forward.saveFailed");
  }
  if (draft.mode === "relay" && !draft.egressId) errors.egress_node_id = t("forward.chooseEgress");
  if (draft.mode === "direct" && (!draft.targetHost.trim() || !port)) {
    if (!draft.targetHost.trim()) errors.target_host = t("forward.saveFailed");
    if (!port) errors.target_port = t("forward.saveFailed");
  }
  return errors;
}

/**
 * V5-WP5-A1：tls 路径的形态预检（**只有 tls 行**会渲染这两个输入）。
 *
 * 复用 `lib/forward-protocol.ts` 的 `tlsPathFieldErrors` —— 与创建表单、后端
 * `tlsPathsForProtocol` 是同一份规则，不在这里另写一遍：
 *   · tls 必须同时给出两个以 `/` 开头的绝对路径（后端 candidate 校验同样要求成对）；
 *   · 非 tls 行不会走到这里（调用方先看协议），但函数本身也对路径说「不允许」。
 */
export function draftTlsPathErrors(
  forward: Pick<PortForward, "protocol">,
  draft: { tlsCertPath: string; tlsKeyPath: string },
): TlsPathFieldErrors {
  if (forwardProtocolFact(forward.protocol) !== TLS_FORWARD_PROTOCOL) return {};
  return tlsPathFieldErrors(
    TLS_FORWARD_PROTOCOL,
    draft.tlsCertPath ?? "",
    draft.tlsKeyPath ?? "",
  );
}

type PreviewState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ready"; result: import("@/lib/types").ForwardPreviewResult }
  | { kind: "blocked"; message: string; code?: string };

export function ForwardEditDialog({
  open,
  onOpenChange,
  forward,
  nodes,
  bindings,
  onSaved,
  onReload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  forward: PortForward;
  /** 当前 workspace 的节点（用于 ingress/egress 选择）。 */
  nodes: UserNode[];
  /** ingress_id → 已绑定的出口列表（每行带后端下发的 `used_by_forward_count`）。 */
  bindings: Record<string, NodeBinding[]>;
  onSaved: (updated: PortForward) => void;
  onReload: () => void;
}) {
  const { t, locale } = useI18n();
  const { currentId, permissions, canForward } = useWorkspace();
  const allowed = canForward(forward, "update");
  const [draft, setDraft] = useState<Draft>(() => draftFrom(forward));
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ kind: "idle" });
  const [conflict, setConflict] = useState<number | null>(null);
  const seq = useRef(0);

  const expectedRevision = forward.config_revision ?? forward.latest_revision ?? 0;

  /**
   * V5-WP5-A1：协议只读提示。
   *
   * 后端 `ForwardPatchSchema` 只接受 `tls_cert_path` / `tls_key_path`（tls 行的证书
   * 路径可改），**不接受** `protocol`：把 tcp 改成 tls 不是一次编辑（端口租约、目标
   * 语义、RELAY 形态都会变），§6.1 没有冻结那套语义，所以 schema 用「不接受这个键」
   * 而不是猜一个行为。这里只读展示事实 + 一句「为什么改不了」，而不是摆一个点了
   * 注定失败的下拉框。
   */
  const protocolFact = isForwardProtocol(forward.protocol) ? forward.protocol : null;
  const protocolHint = protocolFact
    ? `${t("forward.protocolFixedHint")} ${forwardProtocolNote(locale, protocolFact)}`
    : t("forward.protocolFixedHint");

  /** 该行是不是 tls：决定渲染哪些协议专属字段（路径只属于 tls）。 */
  const isTlsForward = forwardProtocolFact(forward.protocol) === TLS_FORWARD_PROTOCOL;
  /**
   * datagram（udp）行在说「连接」的地方必须换措辞 —— 报文映射没有连接可保持、
   * 没有连接可 drain（§6.2）。`transport === null`（历史/未开放协议）走 stream
   * 措辞：那种行根本不会被下发（preview 会先拒绝），措辞不可能被用户看到。
   */
  const datagram = forwardTransportFor(forward.protocol) === "datagram";
  // 打开时重置草稿；forward 变化（刷新后）也重置，避免拿旧草稿覆盖别人保存。
  useEffect(() => {
    if (open) {
      setDraft(draftFrom(forward));
      setConflict(null);
    }
  }, [open, forward]);

  const patch = useMemo(() => draftToPatch(forward, draft), [forward, draft]);
  const patchKeys = useMemo(() => Object.keys(patch), [patch]);
  const formErrors = useMemo(() => draftFormErrors(draft, t), [draft, t]);
  const hasFormError = Object.keys(formErrors).length > 0;
  /**
   * tls 路径的预检错误（非 tls 行恒为空对象）。它和形态预检**并列**参与闸门，
   * 但不进 `draftFormErrors`（那个函数的字段集是「创建字段集」，由源码断言钉住）。
   */
  const tlsErrors = useMemo(() => draftTlsPathErrors(forward, draft), [forward, draft]);
  const hasTlsError = Object.keys(tlsErrors).length > 0;
  const empty = patchKeys.length === 0;

  useEffect(() => {
    if (!open || !allowed) return;
    if (empty) {
      setPreview({ kind: "idle" });
      return;
    }
    if (hasFormError || hasTlsError) {
      setPreview({ kind: "idle" });
      return;
    }
    let cancelled = false;
    const current = ++seq.current;
    setPreview({ kind: "checking" });
    const timer = setTimeout(() => {
      api.forwards
        .preview(forward.id, patch)
        .then((result) => {
          if (cancelled || current !== seq.current) return;
          if (result.validation.ok) {
            setPreview({ kind: "ready", result });
          } else {
            setPreview({
              kind: "blocked",
              message: result.validation.errors[0] ?? t("forward.previewFailed"),
            });
          }
        })
        .catch((error: unknown) => {
          if (cancelled || current !== seq.current) return;
          const apiError = error as { status?: number; message?: string; data?: { latest_revision?: number } };
          if (apiError?.status === 409 && apiError.data?.latest_revision != null) {
            setConflict(apiError.data.latest_revision);
            return;
          }
          setPreview({
            kind: "blocked",
            message: apiError instanceof Error ? apiError.message : t("forward.previewFailed"),
          });
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, empty, hasFormError, hasTlsError, forward.id, patch, t, allowed, currentId, permissions]);

  const ingressNodes = useMemo(
    () => nodes.filter((node) => node.role === "ingress" || node.role === "both"),
    [nodes],
  );
  const boundEgress = useMemo(() => {
    if (!draft.ingressId) return [];
    return (bindings[draft.ingressId] ?? []).map((binding) => ({
      id: Number(binding.egress_node_id),
      node: binding.egress_node,
    }));
  }, [bindings, draft.ingressId]);

  /**
   * V4-WP9 Binding usage：当前入口节点每条绑定的使用量与解绑闸门状态。
   *
   * 使用量直接取后端下发的 `used_by_forward_count` / `unbind_blocked`
   * （`GET /api/nodes/:id/bindings` 的响应投影），前端**不重新统计** ——
   * 否则「列表说可解绑、删除又被 409 拒绝」这类自相矛盾的体验会重现。
   */
  const bindingUsageRows = useMemo(() => {
    if (!draft.ingressId) return [];
    return (bindings[draft.ingressId] ?? []).map((binding) => ({
      label: binding.egress_node?.node_id ?? String(binding.egress_node_id),
      usage: bindingUsageView(binding),
    }));
  }, [bindings, draft.ingressId]);

  const saveBlocked =
    !allowed ||
    saving ||
    empty ||
    hasFormError ||
    // tls 行缺路径（或路径不合法）时不允许保存：后端候选校验要求成对，发过去只会
    // 换一个 400（而且 patch 侧目前会静默丢弃，见任务回报的契约缺口）。
    hasTlsError ||
    preview.kind !== "ready" ||
    conflict !== null;

  async function save() {
    if (saveBlocked) return;
    setSaving(true);
    try {
      // §13.3.3：一次编辑 = 一个完整 patch + expected_revision 闸门。
      const updated = await api.forwards.update(forward.id, {
        ...patch,
        expected_revision: expectedRevision,
      });
      if (getActiveWorkspace() !== currentId) return;
      const revision = updated.config_revision ?? updated.latest_revision;
      onSaved(updated);
      onOpenChange(false);
      toast.success(
        revision != null
          ? t("forward.savedApplying", { revision: String(revision) })
          : t("forward.saveSuccess"),
      );
    } catch (error) {
      const apiError = error as {
        status?: number;
        message?: string;
        data?: { latest_revision?: number };
      };
      if (apiError?.status === 409 && apiError.data?.latest_revision != null) {
        // §13.3.3：409 → 提示最新 revision → 用户刷新后重新确认。
        setConflict(apiError.data.latest_revision);
        return;
      }
      toast.error(
        apiError instanceof Error ? apiError.message : t("forward.saveFailed"),
      );
    } finally {
      setSaving(false);
    }
  }

  /**
   * 影响面文案。
   *
   * V5.1b：两条线**只在 stream 上成立**，datagram（udp）必须换成映射语义 ——
   * 「存量连接被 drain」「旧连接保持」在 udp 上都是错的事实（§6.2：映射按空闲过期，
   * 没有连接可 drain，目标侧也没有可持有的对象）。措辞的选择由**传输**决定
   * （`datagram`），不是由协议名字决定，所以将来再加报文协议不需要改这里两次。
   */
  const impactLines = useMemo(() => {
    if (preview.kind !== "ready") return [];
    const impact = preview.result.impact;
    if (impact.metadata_only) {
      const lines = [t("forward.impactMetadataOnly")];
      /**
       * 后端把「只改了 tls 路径」也判成 metadata_only（`isMetadataOnlyPatch` 只比较
       * mode/协议/节点/端口/目标，不含两列路径），而 metadata-only 分支只写 `name`：
       * 该判定下路径既不会落库、也不会下发。这里把这个事实说出来，而不是让用户看着
       * 「已保存」以为证书换了。条件挂在后端自己的 `metadata_only` 上，所以后端一旦
       * 把路径纳入比较，这条提示会**自动消失**（不会变成一句常年错误的警告）。
       */
      if (
        patch.tls_cert_path !== undefined ||
        patch.tls_key_path !== undefined
      ) {
        lines.push(t("forward.impactMetadataOnlyTlsPaths"));
      }
      return lines;
    }
    const lines: string[] = [];
    if (impact.changes_external_address) lines.push(t("forward.impactExternalAddress"));
    if (impact.listener_replacement) {
      lines.push(datagram ? t("forward.impactListenerDatagram") : t("forward.impactListener"));
    }
    if (impact.target_change && !impact.mode_change) {
      lines.push(datagram ? t("forward.impactTargetDatagram") : t("forward.impactTarget"));
    }
    if (impact.ingress_node_change) lines.push(t("forward.impactIngress"));
    if (impact.egress_node_change) lines.push(t("forward.impactEgress"));
    if (impact.mode_change) lines.push(t("forward.impactMode"));
    if (impact.listen_port_change && !impact.changes_external_address) {
      lines.push(t("forward.impactPort"));
    }
    // auto-port：端口留空 = 由系统分配，必须显式说出来，而不是给一个假端口号。
    if (impact.port_status === "auto") lines.push(t("forward.impactPortAuto"));
    if (impact.binding_required) lines.push(t("forward.impactBinding"));
    if (impact.nodes_prepare_drain.length > 0) {
      lines.push(
        t("forward.impactNodes", { nodes: impact.nodes_prepare_drain.join(", ") }),
      );
    }
    return lines;
  }, [preview, t, datagram, patch]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("forward.editForward")}</DialogTitle>
          <DialogDescription>{t("forward.editDialogHint")}</DialogDescription>
        </DialogHeader>

        {conflict !== null ? (
          <div className="rounded-md border border-[var(--destructive)]/30 bg-[var(--destructive)]/5 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-[var(--destructive)]">
              <ShieldAlert className="size-4" />
              {t("forward.revisionConflictTitle")}
            </div>
            <p className="mt-2 text-sm text-[var(--muted-foreground)]">
              {t("forward.revisionConflictHint", { revision: String(conflict) })}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={() => {
                onOpenChange(false);
                onReload();
              }}
            >
              {t("forward.reloadAndRetry")}
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("common.name")}>
              <Input
                value={draft.name}
                maxLength={60}
                onChange={(event) => setDraft((d) => ({ ...d, name: event.target.value }))}
              />
            </Field>

            <Field label={t("forward.protocol")} hint={protocolHint}>
              <div
                className="flex h-9 items-center rounded-md border border-[var(--border)] bg-[var(--muted)]/40 px-3"
                data-testid="forward-edit-protocol"
              >
                <ForwardProtocolBadge forward={forward} />
              </div>
            </Field>

            <Field label={t("forward.mode")}>
              <Select
                value={draft.mode}
                onValueChange={(value) =>
                  setDraft((d) => ({
                    ...d,
                    mode: value === "relay" ? "relay" : "direct",
                    // §13.3.1 direct↔relay 切换必须重填拓扑字段：
                    // direct 的 egress 必须为 null，relay 必须显式选出口。
                    egressId: value === "relay" ? "" : d.egressId,
                    targetHost: value === "relay" ? d.targetHost : d.targetHost,
                    targetPort: value === "relay" ? d.targetPort : d.targetPort,
                  }))
                }
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="direct">{t("forward.direct")}</SelectItem>
                  <SelectItem value="relay">{t("forward.relay")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field label={t("forward.ingressNode")} error={formErrors.ingress_node_id}>
              <Select
                value={draft.ingressId}
                onValueChange={(value) =>
                  setDraft((d) => ({ ...d, ingressId: value, egressId: "" }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("forward.chooseIngress")} />
                </SelectTrigger>
                <SelectContent>
                  {ingressNodes.map((node) => (
                    <SelectItem key={String(node.id)} value={String(node.id)}>
                      {node.node_id} · {node.connect_ip ?? t("node.waiting")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label={t("forward.egressNode")} error={formErrors.egress_node_id}>
              {draft.mode === "relay" ? (
                <Select value={draft.egressId} onValueChange={(value) => setDraft((d) => ({ ...d, egressId: value }))}>
                  <SelectTrigger>
                    <SelectValue placeholder={t("forward.chooseEgress")} />
                  </SelectTrigger>
                  <SelectContent>
                    {boundEgress.map((entry) => (
                      <SelectItem key={String(entry.id)} value={String(entry.id)}>
                        {entry.node.node_id} · {entry.node.connect_ip ?? t("node.waiting")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input value={t("common.none")} disabled readOnly />
              )}
            </Field>

            <Field
              label={t("forward.listenPort")}
              hint={t(listenPortHintKey(draft.listenPort))}
              error={formErrors.listen_port}
            >
              <Input
                inputMode="numeric"
                value={draft.listenPort}
                placeholder={t(listenPortPlaceholderKey(draft.listenPort))}
                onChange={(event) => setDraft((d) => ({ ...d, listenPort: event.target.value }))}
              />
            </Field>

            <Field label={t("forward.targetHost")} error={formErrors.target_host}>
              <Input
                value={draft.targetHost}
                placeholder="example.com"
                onChange={(event) => setDraft((d) => ({ ...d, targetHost: event.target.value }))}
              />
            </Field>

            <Field label={t("forward.targetPort")} error={formErrors.target_port}>
              <Input
                inputMode="numeric"
                value={draft.targetPort}
                placeholder="443"
                onChange={(event) => setDraft((d) => ({ ...d, targetPort: event.target.value }))}
              />
            </Field>

            {/*
              V5-WP5-A1：tls 的证书/私钥路径 —— **可编辑**（后端 patch schema 已接受，
              规则与创建完全相同：只有 tls 能带、必须成对）。
              只在 tls 行出现：tcp/ws 携带路径是 400，udp 更没有 TLS 前端可言。
            */}
            {isTlsForward ? (
              <>
                <Field
                  label={t("forward.tlsCertPath")}
                  hint={t("forward.tlsPathsHint")}
                  error={tlsErrors.tls_cert_path ? t(tlsErrors.tls_cert_path) : undefined}
                >
                  <Input
                    value={draft.tlsCertPath}
                    maxLength={FORWARD_TLS_PATH_MAX}
                    placeholder="/etc/tunex/tls/front.crt"
                    data-testid="forward-tls-cert-path"
                    required
                    aria-invalid={tlsErrors.tls_cert_path ? true : undefined}
                    onChange={(event) =>
                      setDraft((d) => ({ ...d, tlsCertPath: event.target.value }))
                    }
                  />
                </Field>
                <Field
                  label={t("forward.tlsKeyPath")}
                  error={tlsErrors.tls_key_path ? t(tlsErrors.tls_key_path) : undefined}
                >
                  <Input
                    value={draft.tlsKeyPath}
                    maxLength={FORWARD_TLS_PATH_MAX}
                    placeholder="/etc/tunex/tls/front.key"
                    data-testid="forward-tls-key-path"
                    required
                    aria-invalid={tlsErrors.tls_key_path ? true : undefined}
                    onChange={(event) =>
                      setDraft((d) => ({ ...d, tlsKeyPath: event.target.value }))
                    }
                  />
                </Field>
              </>
            ) : null}

            {/*
              V4-WP9 Binding usage：当前入口节点每条绑定被多少条 Forward 占用，
              并区分「正在使用（解绑会被后端 409 拒绝）」与「未被使用（可解绑）」。
              只在 relay 下展示 —— direct 根本不使用出口绑定，列出来只会是噪音。
              数字与 `unbind_blocked` 都来自 bindings 响应投影，本处只负责展示。
            */}
            {draft.mode === "relay" && bindingUsageRows.length > 0 ? (
              <div className="rounded-md border border-[var(--border)] p-3 sm:col-span-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Link2 className="size-4" />
                  {t("forward.bindingUsageTitle")}
                </div>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  {t("forward.bindingUsageHint")}
                </p>
                <ul className="mt-2 space-y-1.5">
                  {bindingUsageRows.map((row) => {
                    const deletable = row.usage.state === "deletable";
                    return (
                      <li
                        key={row.label}
                        className="flex flex-wrap items-center justify-between gap-2 text-xs"
                      >
                        <span className="font-mono">{row.label}</span>
                        <span className="flex items-center gap-2">
                          <span className="text-[var(--muted-foreground)]">
                            {deletable
                              ? t("forward.bindingUsageUnused")
                              : t("forward.bindingUsageUsed", {
                                  count: String(row.usage.used_by_forward_count),
                                })}
                          </span>
                          <Badge variant={deletable ? "outline" : "secondary"}>
                            {deletable
                              ? t("forward.bindingUsageDeletable")
                              : t("forward.bindingUsageInUse")}
                          </Badge>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </div>
        )}

        {conflict === null ? (
          <div className="rounded-md border border-[var(--border)] bg-[var(--muted)]/40 p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Info className="size-4" />
              {t("forward.impactTitle")}
            </div>
            {preview.kind === "idle" ? (
              <p className="mt-2 text-xs text-[var(--muted-foreground)]">
                {empty ? t("forward.impactNoChange") : t("forward.previewIdle")}
              </p>
            ) : null}
            {preview.kind === "checking" ? (
              <p className="mt-2 flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
                <Loader2 className="size-3 animate-spin" />
                {t("forward.previewChecking")}
              </p>
            ) : null}
            {preview.kind === "blocked" ? (
              <div className="mt-2 flex items-start gap-2 text-xs text-[var(--destructive)]">
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
                <div>
                  <div className="font-medium">{t("forward.blockingTitle")}</div>
                  <div className="mt-0.5">{preview.message}</div>
                </div>
              </div>
            ) : null}
            {preview.kind === "ready" ? (
              <div className="mt-2 space-y-1.5">
                {impactLines.length === 0 ? (
                  <p className="text-xs text-[var(--muted-foreground)]">
                    {t("forward.impactMetadataOnly")}
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {impactLines.map((line) => (
                      <li key={line} className="flex items-start gap-2 text-xs">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[var(--warning,currentColor)]" />
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {preview.result.impact.desired_address ? (
                    <Badge variant="secondary" className="font-mono text-xs">
                      {t("forward.impactDesiredAddress", {
                        address: preview.result.impact.desired_address,
                      })}
                    </Badge>
                  ) : (
                    <span className="text-xs text-[var(--muted-foreground)]">
                      {t("forward.impactDesiredAddressUnknown")}
                    </span>
                  )}
                  <CopyAddress value={preview.result.impact.desired_address} />
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <span className="mr-auto text-xs text-[var(--muted-foreground)]">
            {t("forward.savedRevision")}: {expectedRevision}
          </span>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void save()} disabled={saveBlocked}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 地址复制（result UX：保存后的访问地址必须能一键复制）。 */
export function CopyAddress({ value }: { value: string | null }) {
  const { t } = useI18n();
  const copy = useCallback(async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("common.copied"));
    } catch {
      toast.error(t("forward.copyFailed"));
    }
  }, [value, t]);
  if (!value) return null;
  return (
    <Button size="sm" variant="ghost" onClick={() => void copy()} aria-label={t("forward.copyAddress")}>
      <Copy className="size-3.5" />
      {t("forward.copyAddress")}
    </Button>
  );
}

/**
 * running-vs-desired 判定（纯函数，便于单测）。
 *
 * §13.4：用户要的是「现在跑的」和「你要改的」是不是一回事，不是两个 revision
 * 数字。优先级 = 异常状态 > 落后/落后推进中 > 同步。
 *  - `applied < desired`：已保存的 desired 还没完全下发（滚动中）
 *  - apply_status 处于 pending/applying：下层正在推进
 *  - error/suspended：需要用户介入的运行态异常
 */
export function forwardRunningState(forward: PortForward): {
  state: "synced" | "pending" | "error" | "suspended";
  applied: number | null;
  desired: number | null;
} {
  const desired = forward.config_revision ?? forward.latest_revision ?? null;
  const applied = forward.applied_revision ?? null;
  const status = forward.apply_status ?? null;
  if (status === "suspended") return { state: "suspended", applied, desired };
  if (status === "error") return { state: "error", applied, desired };
  if (desired !== null && applied !== null && applied < desired) {
    return { state: "pending", applied, desired };
  }
  if (status === "pending" || status === "applying") {
    return { state: "pending", applied, desired };
  }
  return { state: "synced", applied, desired };
}

/** running-vs-desired 的状态语义（§13.4：产品状态，不堆 revision 数字）。 */
export function RunningVsDesiredBadge({ forward }: { forward: PortForward }) {
  const { t } = useI18n();
  const { state, applied, desired } = forwardRunningState(forward);

  if (state === "suspended") {
    return <Badge variant="secondary">{t("forward.runningSuspended")}</Badge>;
  }
  if (state === "error") {
    return <Badge variant="destructive">{t("forward.runningError")}</Badge>;
  }
  if (state === "pending") {
    return (
      <Badge variant="outline">
        {t("forward.runningPending", {
          applied: applied != null ? String(applied) : "—",
          desired: desired != null ? String(desired) : "—",
        })}
      </Badge>
    );
  }
  return <Badge variant="success">{t("forward.runningSynced")}</Badge>;
}
