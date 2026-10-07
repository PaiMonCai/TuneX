import { z } from "zod";
import { isIP } from "node:net";

// ForwardX rule semantics: ordered, at most ten distinct targets, and explicit
// consecutive failure/recovery windows. UDP silence is never a failed probe.
const target = z.object({
  host: z.string().trim().min(1).max(255).refine((h) => !/[\s/\\\x00-\x1f\x7f\[\]]/.test(h)
    && (!h.includes(":") || isIP(h) !== 0)),
  port: z.number().int().min(1).max(65_535),
}).strict();
export const LinkTargetSetSchema = z.object({
  version: z.literal(1),
  targets: z.array(target).min(1).max(10),
  strategy: z.enum(["fallback", "round_robin", "random"]),
  failure_seconds: z.number().int().min(10).max(3600),
  recover_seconds: z.number().int().min(10).max(3600),
  probe: z.enum(["tcp", "none"]),
}).strict().superRefine((set, ctx) => {
  const seen = new Set<string>();
  set.targets.forEach((item, index) => {
    const key = JSON.stringify([item.host.toLowerCase(), item.port]);
    if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["targets", index], message: "duplicate_target" });
    seen.add(key);
  });
});
export type LinkTargetSet = z.infer<typeof LinkTargetSetSchema>;
export function targetSetMatchesFirst(set: LinkTargetSet, host: string, port: number): boolean {
  return set.targets[0]!.host.toLowerCase() === host.trim().toLowerCase() && set.targets[0]!.port === port;
}
export function persistedLinkTargetSet(raw: unknown): LinkTargetSet | undefined {
  // Missing is the exact legacy single-target configuration; never silently
  // coerce corrupt stored multi-target state into its first destination.
  return raw == null ? undefined : LinkTargetSetSchema.parse(raw);
}
