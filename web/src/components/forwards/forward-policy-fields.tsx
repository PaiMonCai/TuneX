"use client";
import { Field } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { FORWARD_POLICY_FIELDS, FORWARD_POLICY_MAX, forwardPolicyDraftErrors, type ForwardPolicyDraft } from "@/lib/forward-policy";

export function ForwardPolicyFields({ draft, onChange, locale }: {
  draft: ForwardPolicyDraft; onChange: (patch: ForwardPolicyDraft) => void; locale: string;
}) {
  const chinese = locale.startsWith("zh");
  const labels = chinese ? ["上传速率（bytes/sec）", "下载速率（bytes/sec）", "总并发上限", "每来源 IP 并发上限"]
    : ["Upload (bytes/sec)", "Download (bytes/sec)", "Total concurrency", "Concurrency per source IP"];
  const errors = forwardPolicyDraftErrors(draft);
  return <div className="col-span-full grid grid-cols-1 gap-4 sm:grid-cols-2">
    <p className="col-span-full text-xs text-muted-foreground">{chinese
      ? "策略作用于此转发的业务入口；TCP 计连接，UDP 计活跃映射。原生 both 是一条规则，TCP 流与 UDP 映射共享总并发、每来源 IP 并发和双向速率预算，不是两套额度。0 表示不限，仍受 workspace 上限约束。速率最大 2147483647 bytes/sec（约 2 GiB/s）。"
      : "Applies at this Forward's client entrance: TCP connections, UDP active mappings. Native both is one rule: TCP streams and UDP mappings share total/per-source-IP concurrency and directional rate budgets, not two allowances. 0 means unlimited, subject to workspace ceilings. Maximum rate: 2147483647 bytes/sec (about 2 GiB/s)."}</p>
    {FORWARD_POLICY_FIELDS.map((key, index) => <Field key={key} label={labels[index]!} error={errors[key]}>
      <Input inputMode="numeric" min={0} max={FORWARD_POLICY_MAX} value={draft[key] ?? "0"}
        aria-invalid={!!errors[key]} data-testid={`forward-${key}`} onChange={(event) => onChange({ [key]: event.target.value })} />
    </Field>)}
  </div>;
}
