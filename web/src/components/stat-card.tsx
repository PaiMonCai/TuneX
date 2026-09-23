import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

/** 仪表盘统计卡片（服务端渲染；title 已由 serverT() 解析为当前语言） */
export function StatCard({
  title,
  value,
  hint,
  icon: Icon,
  testId,
  className,
}: {
  title: string;
  value: string;
  hint?: string;
  icon?: React.ComponentType<{ className?: string }>;
  testId?: string;
  className?: string;
}) {
  return (
    <Card className={cn(className)}>
      <CardContent className="flex items-start justify-between gap-3 p-5">
        <div className="min-w-0">
          <p className="text-xs text-[var(--muted-foreground)]">{title}</p>
          <p className="mt-1.5 truncate text-2xl font-semibold" data-testid={testId}>
            {value}
          </p>
          {hint && <p className="mt-1 truncate text-xs text-[var(--muted-foreground)]">{hint}</p>}
        </div>
        {Icon && (
          <div className="grid size-9 shrink-0 place-items-center rounded-md bg-[var(--muted)] text-[var(--muted-foreground)]">
            <Icon className="size-4" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
