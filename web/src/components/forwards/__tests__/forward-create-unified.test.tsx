import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ForwardEmptyState } from "../forward-empty-state";
import { ForwardToolbar } from "../forward-toolbar";
import { getDictionary, makeT } from "@/lib/i18n";

const workspaceSource = readFileSync(new URL("../forward-workspace.tsx", import.meta.url), "utf8");
const encryptedSource = readFileSync(new URL("../encrypted-forward-create-dialog.tsx", import.meta.url), "utf8");
const tableSource = readFileSync(new URL("../forward-table.tsx", import.meta.url), "utf8");

describe("unified Forward product entry", () => {
  for (const locale of ["zh", "en"] as const) {
    const t = makeT(getDictionary(locale));
    test(`${locale}: one creation action in toolbar instead of competing direct/relay CTAs`, () => {
      const markup = renderToStaticMarkup(<ForwardToolbar
        mode="all" status="all" ingress="all" egress="all" keyword=""
        ingressNodes={[]} egressNodes={[]} canCreate t={t} text={() => "All egress"}
        onMode={() => {}} onStatus={() => {}} onIngress={() => {}} onEgress={() => {}}
        onKeyword={() => {}} onCreate={() => {}} />);
      expect(markup).toContain('data-testid="forward-create-unified"');
      expect(markup).toContain(t("forward.createForward"));
      expect(markup).not.toContain(t("forward.createDirect"));
      expect(markup).not.toContain(t("forward.createRelay"));
      expect(markup.match(/data-testid="forward-create-unified"/g)).toHaveLength(1);
    });

    test(`${locale}: empty state explains native vs encrypted and remains one action`, () => {
      const markup = renderToStaticMarkup(<ForwardEmptyState canCreate t={t} onCreate={() => {}} />);
      expect(markup).toContain(t("forward.nativeType"));
      expect(markup).toContain(t("forward.encryptedType"));
      expect(markup).toContain(t("forward.createForward"));
      expect(markup).not.toContain("forward.emptyUnifiedHint");
    });
  }

  test("all Forward creations start at one choice; native retains direct/relay path", () => {
    expect(workspaceSource).toContain("forward-create-choice");
    expect(workspaceSource).toContain('openCreate("direct")');
    expect(workspaceSource).toContain('openCreate("relay")');
    expect(workspaceSource).toContain("<EncryptedForwardCreateDialog");
  });

  test("FXP creation stays under Link writer, not ordinary Forward mutation", () => {
    expect(encryptedSource).toContain("linksApi.createForward(workspaceId, id, binding)");
    expect(encryptedSource).toContain("linksApi.create(workspaceId, input)");
    expect(encryptedSource).not.toContain("api.forwards.create");
    expect(encryptedSource).toContain("setWriteUnconfirmed(true)");
    expect(tableSource).toContain("linkedForwardHref(forward)");
    expect(tableSource).toContain("forward-fxp-");
  });
});
