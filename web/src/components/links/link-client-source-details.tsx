import type { LinkForward } from "@/lib/links-types";
import type { LinksCopy } from "./links-copy";

/** Configuration only: no runtime/source-health inference from ACK, Ready or target health. */
export function ForwardClientSource({ forward, copy }: { forward: LinkForward; copy: LinksCopy }) {
  const source = forward.client_source;
  return <section aria-label={copy.clientSourcePolicy} className="space-y-3 border-t border-[var(--border)] pt-3 text-sm">
    <h5 className="font-medium">{copy.clientSourcePolicy}</h5>
    {!source ? <p className="text-[var(--muted-foreground)]">{copy.sourceLegacy}</p> : <>
      <dl className="grid gap-3 sm:grid-cols-2">
        <div><dt className="text-[var(--muted-foreground)]">{copy.clientSourcePolicy}</dt><dd className="font-medium">{source.receive_proxy ? copy.sourceTrustedProxy : copy.sourceSocket}</dd></div>
        <div><dt className="text-[var(--muted-foreground)]">{copy.sendProxy}</dt><dd className="font-medium">{source.send_proxy === "off" ? copy.sendProxyOff : `PROXY ${source.send_proxy}`}</dd></div>
      </dl>
      {!!source.trusted_cidrs.length && <div><p className="text-[var(--muted-foreground)]">{copy.trustedCidrs}</p>
        <ul className="space-y-1">{source.trusted_cidrs.map((cidr, i) => <li key={i} className="break-all font-medium">{cidr}</li>)}</ul>
      </div>}
      {source.receive_proxy && <p className="text-[var(--muted-foreground)]">{copy.sourceReceiveHint}</p>}
      {source.send_proxy !== "off" && <p className="text-[var(--muted-foreground)]">{copy.sourceSendHint}</p>}
      <p className="text-[var(--muted-foreground)]">{copy.sourceSocketHint}</p>
    </>}
    <p className="text-[var(--muted-foreground)]">{copy.sourcePolicyHint}</p>
  </section>;
}
