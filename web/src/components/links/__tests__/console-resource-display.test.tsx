import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ForwardSummaryCards } from "@/components/forwards/forward-summary-cards";
import { LinkResourceCollection } from "@/components/links/link-resource-collection";
import { linksCopy } from "@/components/links/links-copy";
import { getDictionary, makeT } from "@/lib/i18n";
import type { LinkResource } from "@/lib/links-types";
import type { ForwardSummary } from "@/lib/types";

const link: LinkResource = {
  id: 41, workspace_id: 1, name: "HK to JP", carrier: "fxp", status: "active",
  desired_version: 1, generation: 1, ref_count: null,
};
const zero: ForwardSummary = { total: 0, direct: 0, relay: 0, active: 0, pending: 0, suspended: 0, error: 0, traffic: 0 };

describe("console resource facts remain truthful after layout changes", () => {
  for (const locale of ["zh", "en"] as const) {
    const t = makeT(getDictionary(locale));
    const copy = linksCopy(locale);

    test(`${locale}: unavailable Forward summary never becomes measured zero`, () => {
      const html = renderToStaticMarkup(<ForwardSummaryCards summary={null} loading={false} t={t} />);
      expect(html.match(/>—</g)).toHaveLength(4);
      expect(html).not.toContain("0 B");
      expect(html).not.toContain(">0<");
    });

    test(`${locale}: measured zero remains distinct from unavailable data`, () => {
      const html = renderToStaticMarkup(<ForwardSummaryCards summary={zero} loading={false} t={t} />);
      expect(html).toContain("0 B");
      expect(html).toContain(">0<");
      expect(html).not.toContain(">—<");
    });

    test(`${locale}: deployed list metadata does not claim live runtime readiness`, () => {
      const html = renderToStaticMarkup(<LinkResourceCollection links={[link]} selected={link.id} disabled={false} copy={copy} onSelect={() => {}} />);
      expect(html).toContain(copy.statusActive);
      expect(html).not.toContain(copy.statusRunning);
      expect(html).toContain(copy.unknown);
      expect(html).toContain('aria-pressed="true"');
      expect(html).toContain(`aria-label="${copy.searchLinks}"`);
    });

    test(`${locale}: active operation locks native and card selection`, () => {
      const html = renderToStaticMarkup(<LinkResourceCollection links={[link]} selected={link.id} disabled={true} copy={copy} onSelect={() => {}} />);
      expect(html).toContain(copy.selectionLocked);
      expect(html.match(/<select[^>]*disabled=""/)).not.toBeNull();
      expect(html.match(/<button[^>]*disabled=""/)).not.toBeNull();
    });
  }
});
