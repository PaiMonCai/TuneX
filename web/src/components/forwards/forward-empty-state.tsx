"use client";
import { ArrowLeftRight, LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
type Translate = (key: string) => string;

export function ForwardEmptyState({ canCreate, t, onCreate }: { canCreate: boolean; t: Translate; onCreate: () => void }) {
  return <Card data-testid="forward-empty-unified">
    <CardHeader>
      <CardTitle>{t("forward.title")}</CardTitle>
      <CardDescription>{t("forward.emptyUnifiedHint")}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex items-start gap-2 rounded-md border border-[var(--border)] p-3">
          <ArrowLeftRight className="size-4 shrink-0" aria-hidden="true" />
          <div className="space-y-1"><p className="text-sm font-medium">{t("forward.nativeType")}</p>
            <p className="text-xs text-[var(--muted-foreground)]">{t("forward.nativeTypeHint")}</p></div>
        </div>
        <div className="flex items-start gap-2 rounded-md border border-[var(--border)] p-3">
          <LockKeyhole className="size-4 shrink-0" aria-hidden="true" />
          <div className="space-y-1"><p className="text-sm font-medium">{t("forward.encryptedType")}</p>
            <p className="text-xs text-[var(--muted-foreground)]">{t("forward.encryptedTypeHint")}</p></div>
        </div>
      </div>
      <Button disabled={!canCreate} onClick={onCreate}>{t("forward.createForward")}</Button>
    </CardContent>
  </Card>;
}
