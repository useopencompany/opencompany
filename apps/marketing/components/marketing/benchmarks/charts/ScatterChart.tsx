import { cn } from "@opencompany/ui/lib/utils";

export type ScatterPoint = {
  label: string;
  x: number;
  y: number;
  xDisplay: string;
  yDisplay: string;
  /** Flip the label above the dot instead of below, for points that would otherwise collide. */
  labelAbove?: boolean;
  /** Anchor the label to the left/right of the dot instead of centered, for points that would otherwise collide. */
  labelAlign?: "left" | "center" | "right" | undefined;
};

type ScatterChartProps = {
  data: ScatterPoint[];
  xDomain: [number, number];
  yDomain: [number, number];
  xTicks: number[];
  yTicks: number[];
  xTickLabel: (value: number) => string;
  yTickLabel: (value: number) => string;
};

// Single hue, direct-labeled points — a scatter with more than ~3 series needs
// a categorical palette validated for all-pairs CVD separation, so identity
// here rides on the text label next to each dot, never on a per-point color.
// The plot only labels the model name (position carries the value); the exact
// x/y figures live in the table underneath, so nothing is gated behind reading
// a crowded floating label.
export function ScatterChart({
  data,
  xDomain,
  yDomain,
  xTicks,
  yTicks,
  xTickLabel,
  yTickLabel,
}: ScatterChartProps) {
  const [xMin, xMax] = xDomain;
  const [yMin, yMax] = yDomain;
  const toLeft = (x: number) => `${((x - xMin) / (xMax - xMin)) * 100}%`;
  const toTop = (y: number) => `${100 - ((y - yMin) / (yMax - yMin)) * 100}%`;

  return (
    <div>
      <div className="pt-2 pr-4 pb-8 pl-2">
        <div className="relative ml-12 h-72 border border-border">
          {yTicks.map((tick) => (
            <div
              key={`y-${tick}`}
              className="absolute right-0 left-0 border-border/60 border-t"
              style={{ top: toTop(tick) }}
            >
              <span className="-translate-y-1/2 -translate-x-[calc(100%+8px)] absolute left-0 font-mono text-[11px] text-ink-subtle">
                {yTickLabel(tick)}
              </span>
            </div>
          ))}
          {xTicks.map((tick) => (
            <div
              key={`x-${tick}`}
              className="absolute top-0 bottom-0 border-border/60 border-l"
              style={{ left: toLeft(tick) }}
            >
              <span className="-translate-x-1/2 absolute top-[calc(100%+8px)] left-0 whitespace-nowrap font-mono text-[11px] text-ink-subtle">
                {xTickLabel(tick)}
              </span>
            </div>
          ))}

          {data.map((point) => (
            <div
              key={point.label}
              className="absolute"
              style={{ left: toLeft(point.x), top: toTop(point.y) }}
            >
              <div
                className="-translate-x-1/2 -translate-y-1/2 size-2.5 rounded-full border-2 border-canvas bg-violet-600"
                aria-hidden="true"
              />
              <p
                className={cn(
                  "absolute whitespace-nowrap font-mono text-[11px] text-ink leading-4",
                  point.labelAbove ? "bottom-3" : "top-3",
                  point.labelAlign === "left" && "right-1/2 mr-1.5 text-right",
                  point.labelAlign === "right" && "left-1/2 ml-1.5 text-left",
                  (!point.labelAlign || point.labelAlign === "center") &&
                    "-translate-x-1/2 left-1/2 text-center",
                )}
              >
                {point.label}
              </p>
            </div>
          ))}
        </div>
      </div>

      <table className="w-full border-collapse border-t border-t-border font-mono text-[12px]">
        <tbody>
          {data.map((point) => (
            <tr key={point.label} className="border-border border-b last:border-0">
              <td className="py-1.5 pr-3 text-ink">{point.label}</td>
              <td className="py-1.5 pr-3 text-right text-ink-muted">{point.xDisplay}</td>
              <td className="py-1.5 text-right text-ink-muted">{point.yDisplay}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
