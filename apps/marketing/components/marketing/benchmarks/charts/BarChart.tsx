import { Badge } from "@opencompany/ui/components/badge";
import { cn } from "@opencompany/ui/lib/utils";

export type BarDatum = {
  label: string;
  value: number;
  displayValue: string;
  note?: string | undefined;
  emphasized?: boolean;
  caution?: boolean;
};

type BarChartProps = {
  data: BarDatum[];
  maxValue?: number;
};

// Emphasis form: one accent hue on the row the page's own editorial pick calls
// out, neutral gray on the rest — never a value-ramp on nominal categories.
// Every value is direct-labeled, so no axis/gridlines are needed.
export function BarChart({ data, maxValue }: BarChartProps) {
  const max = maxValue ?? Math.max(...data.map((d) => d.value));

  return (
    <div className="space-y-3">
      {data.map((d) => {
        const pct = max > 0 ? Math.max((d.value / max) * 100, 2) : 0;
        return (
          <div
            key={d.label}
            className="grid grid-cols-[minmax(0,180px)_1fr_auto] items-center gap-3"
          >
            <div className="min-w-0 text-right">
              <p className="truncate font-mono text-[12px] text-ink leading-5">{d.label}</p>
              {d.note ? (
                <p className="truncate font-mono text-[11px] text-ink-subtle leading-4">{d.note}</p>
              ) : null}
              {d.caution ? (
                <Badge variant="warning" className="mt-0.5 ml-auto font-mono text-[10px]">
                  ! Not yet reproduced
                </Badge>
              ) : null}
            </div>
            <div className="h-5 min-w-0 bg-transparent">
              <div
                className={cn(
                  "h-full rounded-r-[4px]",
                  d.emphasized ? "bg-violet-600" : "bg-border-strong",
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
            <p
              className={cn(
                "w-16 shrink-0 text-right font-mono text-[13px] leading-5",
                d.emphasized ? "font-semibold text-ink" : "text-ink-muted",
              )}
            >
              {d.displayValue}
            </p>
          </div>
        );
      })}
    </div>
  );
}
