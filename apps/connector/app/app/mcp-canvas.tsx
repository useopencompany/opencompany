"use client";

import {
  CheckCircle2,
  LinearIcon,
  Link,
  type LucideIcon,
  Plus,
  SlackIcon,
  X,
} from "@opencompany/ui/icons";
import { cn } from "@opencompany/ui/lib/utils";
import * as React from "react";

type CanvasTone = "success" | "warning" | "error" | "muted";

type CanvasNodeKind = "linear" | "connector" | "team" | "slack";

type CanvasNode = {
  id: string;
  kind: CanvasNodeKind;
  eyebrow: string;
  title: string;
  status: string;
  tone: CanvasTone;
  detail: string;
  footer: string;
  removable?: boolean;
};

export type ConnectorCanvasNodeInput = {
  status: string;
  tone: CanvasTone;
  detail: string;
  footer: string;
};

const NODE_ICONS: Record<CanvasNodeKind, LucideIcon> = {
  linear: LinearIcon,
  connector: CheckCircle2,
  team: Link,
  slack: SlackIcon,
};

// Mock upstream MCPs the user can drop onto the canvas. v1 only ships the Slack
// mock — adding it shows how the canvas re-flows cleanly as upstreams change.
const MOCK_UPSTREAMS: CanvasNode[] = [
  {
    id: "slack",
    kind: "slack",
    eyebrow: "Upstream MCP",
    title: "Slack",
    status: "Mock",
    tone: "muted",
    detail: "Mock upstream MCP. Connecting Slack would route its tools through Connector.",
    footer: "https://mcp.slack.com/mcp",
    removable: true,
  },
];

export function McpCanvas({
  linear,
  connector,
  team,
}: {
  linear: ConnectorCanvasNodeInput & { footer: string };
  connector: ConnectorCanvasNodeInput;
  team: ConnectorCanvasNodeInput;
}) {
  const linearNode: CanvasNode = {
    id: "linear",
    kind: "linear",
    eyebrow: "Upstream MCP",
    title: "Linear",
    ...linear,
  };
  const connectorNode: CanvasNode = {
    id: "connector",
    kind: "connector",
    eyebrow: "Policy layer",
    title: "Connector",
    ...connector,
  };
  const teamNode: CanvasNode = {
    id: "team",
    kind: "team",
    eyebrow: "Downstream MCP",
    title: "Team MCP",
    ...team,
  };

  const [mockIds, setMockIds] = React.useState<string[]>([]);
  const upstreams = React.useMemo(() => {
    const mocks = mockIds
      .map((id) => MOCK_UPSTREAMS.find((node) => node.id === id))
      .filter((node): node is CanvasNode => Boolean(node));
    return [linearNode, ...mocks];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mockIds, linear.status, linear.tone, linear.detail, linear.footer]);

  const nextMock = MOCK_UPSTREAMS.find((node) => !mockIds.includes(node.id));

  const containerRef = React.useRef<HTMLDivElement>(null);
  const nodeRefs = React.useRef(new Map<string, HTMLElement>());
  const registerNode = React.useCallback(
    (id: string) => (element: HTMLElement | null) => {
      if (element) nodeRefs.current.set(id, element);
      else nodeRefs.current.delete(id);
    },
    [],
  );

  const [paths, setPaths] = React.useState<string[]>([]);
  const [size, setSize] = React.useState({ width: 0, height: 0 });

  const measure = React.useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const root = container.getBoundingClientRect();
    const rectOf = (id: string) => nodeRefs.current.get(id)?.getBoundingClientRect();

    const connectorRect = rectOf("connector");
    const teamRect = rectOf("team");
    if (!connectorRect || !teamRect) return;

    const rightAnchor = (r: DOMRect) => ({
      x: r.right - root.left,
      y: r.top - root.top + r.height / 2,
    });
    const leftAnchor = (r: DOMRect) => ({
      x: r.left - root.left,
      y: r.top - root.top + r.height / 2,
    });
    const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const dx = Math.max(36, (b.x - a.x) / 2);
      return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
    };

    const connectorLeft = leftAnchor(connectorRect);
    const next: string[] = [];
    for (const upstream of upstreams) {
      const upstreamRect = rectOf(upstream.id);
      if (!upstreamRect) continue;
      next.push(curve(rightAnchor(upstreamRect), connectorLeft));
    }
    next.push(curve(rightAnchor(connectorRect), leftAnchor(teamRect)));

    setPaths(next);
    setSize({ width: root.width, height: root.height });
  }, [upstreams]);

  React.useLayoutEffect(() => {
    measure();
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(container);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div
      ref={containerRef}
      className="relative rounded-xl border border-border bg-muted/20 p-6 sm:p-10"
      style={{
        backgroundImage: "radial-gradient(circle, var(--color-border-subtle) 1px, transparent 1px)",
        backgroundSize: "24px 24px",
      }}
    >
      <svg
        className="pointer-events-none absolute inset-0 text-muted-foreground"
        width={size.width}
        height={size.height}
        viewBox={`0 0 ${size.width} ${size.height}`}
        fill="none"
        aria-hidden="true"
      >
        <title>MCP request flow</title>
        <style>{`
          @keyframes mcpFlow { to { stroke-dashoffset: -14; } }
          .mcp-flow { animation: mcpFlow 0.9s linear infinite; }
          @media (prefers-reduced-motion: reduce) { .mcp-flow { animation: none; } }
        `}</style>
        {paths.map((d, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: paths are positional
          <g key={index}>
            {/* Static base line keeps the connection legible at all times. */}
            <path d={d} stroke="currentColor" strokeWidth={1.5} opacity={0.3} />
            {/* Animated dashes convey direction of flow (source → destination). */}
            <path
              className="mcp-flow"
              d={d}
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeDasharray="2 12"
              opacity={0.85}
            />
          </g>
        ))}
      </svg>

      <div className="relative grid items-center gap-x-10 gap-y-6 md:grid-cols-3 lg:gap-x-16">
        <div className="flex flex-col gap-4">
          {upstreams.map((node) => (
            <CanvasCard
              key={node.id}
              node={node}
              ref={registerNode(node.id)}
              {...(node.removable
                ? {
                    onRemove: () => setMockIds((ids) => ids.filter((id) => id !== node.id)),
                  }
                : {})}
            />
          ))}
          {nextMock ? (
            <button
              type="button"
              onClick={() => setMockIds((ids) => [...ids, nextMock.id])}
              className="flex h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border text-xs text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
            >
              <Plus size={13} />
              Add {nextMock.title}
            </button>
          ) : null}
        </div>

        <div className="flex justify-center">
          <CanvasCard node={connectorNode} ref={registerNode("connector")} highlight />
        </div>

        <div className="flex justify-center">
          <CanvasCard node={teamNode} ref={registerNode("team")} />
        </div>
      </div>
    </div>
  );
}

const CanvasCard = React.forwardRef<
  HTMLElement,
  { node: CanvasNode; highlight?: boolean; onRemove?: () => void }
>(function CanvasCard({ node, highlight, onRemove }, ref) {
  const Icon = NODE_ICONS[node.kind];
  return (
    <article
      ref={ref}
      className={cn(
        "relative w-full rounded-lg border bg-background p-4 transition-colors",
        highlight ? "border-foreground/25 shadow-sm" : "border-border",
      )}
    >
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${node.title}`}
          className="absolute right-2.5 top-2.5 flex size-5 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
        >
          <X size={12} />
        </button>
      ) : null}

      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground">
          <Icon size={16} />
        </span>
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {node.eyebrow}
          </p>
          <h2 className="text-sm font-medium text-foreground">{node.title}</h2>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <span className={cn("size-1.5 rounded-full", toneClassName(node.tone))} />
        <span className="text-xs text-muted-foreground">{node.status}</span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{node.detail}</p>
      <p className="mt-3 truncate border-t border-border/60 pt-2 text-[11px] text-muted-foreground/70">
        {node.footer}
      </p>
    </article>
  );
});

function toneClassName(tone: CanvasTone) {
  switch (tone) {
    case "success":
      return "bg-success";
    case "warning":
      return "bg-warning";
    case "error":
      return "bg-destructive";
    case "muted":
      return "bg-muted-foreground/40";
  }
}
