import type { LinksCopy } from "./links-copy";

/** Machine codes are support details, not primary product copy or raw exception text. */
export function LinkErrorDetails({ codes, copy }: { codes: string[]; copy: LinksCopy }) {
  const safe = [...new Set(codes.filter((code) => /^[a-z][a-z0-9_]{0,95}$/.test(code)))];
  if (!safe.length) return null;
  return <details className="text-xs text-[var(--muted-foreground)]"><summary className="cursor-pointer">{copy.errorDetails}</summary>
    <ul className="mt-2 space-y-1">{safe.map((code) => <li key={code}>{copy.code}: <code>{code}</code></li>)}</ul>
  </details>;
}
