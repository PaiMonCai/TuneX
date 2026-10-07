import { AppShell, currentLocale } from "@/components/app-shell";
import { LinksWorkspace } from "@/components/links/links-workspace";
import { linksCopy } from "@/components/links/links-copy";
import { linkIdFromSelection } from "@/components/links/link-state";

export default async function LinksPage({ searchParams }: { searchParams: Promise<{ selected?: string | string[] }> }) {
  const copy = linksCopy(await currentLocale());
  const selected = (await searchParams).selected;
  const selectedId = linkIdFromSelection(typeof selected === "string" ? selected : null);
  return <AppShell title={copy.title} subtitle={copy.subtitle} activeHref="/links"><LinksWorkspace selectedId={selectedId} /></AppShell>;
}
