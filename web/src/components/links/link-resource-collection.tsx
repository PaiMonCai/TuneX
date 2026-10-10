"use client";

import { useMemo, useState } from "react";
import { Check, Network, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { LinkResource } from "@/lib/links-types";
import type { LinksCopy } from "./links-copy";
import { selectClass } from "./link-forms";
import { linkStatusLabel } from "./link-state";

/** List metadata describes deployment, never live runtime readiness. */
export function LinkResourceCollection({ links, selected, disabled, copy, onSelect }: {
  links: LinkResource[]; selected: number | null; disabled: boolean; copy: LinksCopy;
  onSelect: (id: number) => void;
}) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return links.filter((link) => !search || `${link.name} ${link.id}`.toLocaleLowerCase().includes(search));
  }, [links, query]);

  return (
    <section className="space-y-3" aria-label={copy.select}>
      <div className="console-toolbar">
        <div className="relative w-full min-w-0 sm:max-w-sm">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-2.5 size-4 text-[var(--muted-foreground)]" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9 pr-10"
            aria-label={copy.searchLinks} placeholder={copy.searchLinks} data-testid="links-search" />
          {query && <Button size="icon" variant="ghost" onClick={() => setQuery("")} className="absolute right-0 top-0"
            aria-label={copy.clearSearch}><X /></Button>}
        </div>
        <div className="flex w-full min-w-0 items-center gap-3 sm:w-auto">
          <label htmlFor="links-selected" className="shrink-0 text-xs text-[var(--muted-foreground)]">{copy.select}</label>
          <select id="links-selected" className={`${selectClass} min-w-0 flex-1 sm:w-52`} value={selected ?? ""}
            disabled={disabled} onChange={(event) => onSelect(Number(event.target.value))}>
            {links.map((link) => <option key={link.id} value={link.id}>{link.name}</option>)}
          </select>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 text-xs text-[var(--muted-foreground)]">
        <span aria-live="polite">{visible.length} / {links.length} {copy.title}</span>
        {disabled && <span>{copy.selectionLocked}</span>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3" role="group" aria-label={copy.select}>
        {visible.map((link) => (
          <button type="button" key={link.id} onClick={() => onSelect(link.id)} disabled={disabled}
            aria-pressed={selected === link.id} data-testid="link-resource-card" data-link-id={link.id}
            className={cn("min-w-0 rounded-[var(--radius)] border bg-[var(--card)] p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-60",
              selected === link.id ? "border-[var(--foreground)] ring-1 ring-[var(--foreground)]/10" : "border-[var(--border)] hover:border-[var(--muted-foreground)]/50")}>
            <span className="flex min-w-0 items-center gap-3">
              <span className="console-stat-icon"><Network aria-hidden="true" className="size-5" /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{link.name}</span>
                <span className="mt-0.5 block text-xs text-[var(--muted-foreground)]">FXP · #{link.id}</span>
              </span>
              {selected === link.id && <Check aria-hidden="true" className="size-4 shrink-0" />}
            </span>
            <span className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-3">
              <Badge variant="muted">{linkStatusLabel(link.status, copy)}</Badge>
              <span className="text-xs text-[var(--muted-foreground)]">{copy.refs}: <span className="font-medium tabular-nums text-[var(--foreground)]">{link.ref_count ?? copy.unknown}</span></span>
            </span>
          </button>
        ))}
      </div>
      {!visible.length && <div role="status" className="rounded-[var(--radius)] border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--muted-foreground)]">{copy.noMatches}</div>}
    </section>
  );
}
