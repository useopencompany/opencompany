"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Brand accent (violet, matching the old marketing brain visualization).
const ACCENT = "139, 92, 246";

const WOBBLE_KEYFRAMES = `@keyframes mind-wobble{0%,100%{transform:translate(0,6px)}25%{transform:translate(6px,0)}50%{transform:translate(0,-6px)}75%{transform:translate(-6px,0)}}`;

const CHARS = " .,;:!+*oO#@";

function seededRandom(seed: number) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function generateBrainHTML(time: number) {
  const cols = 52;
  const rows = 32;
  let html = "";

  const angle = time * 0.1;
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);

  const cx = 0.5,
    cy = 0.5;
  const rx = 0.44,
    ry = 0.48;

  for (let y = 0; y < rows; y++) {
    html += '<div class="whitespace-pre">';
    for (let x = 0; x < cols; x++) {
      const px = (x / cols - cx) / rx;
      const py = (y / rows - cy) / ry;
      const r2 = px * px + py * py;

      if (r2 < 1) {
        const pz = Math.sqrt(1 - r2);
        const rx3 = px * cosA + pz * sinA;
        const rz3 = -px * sinA + pz * cosA;

        const light1 =
          Math.max(0, rx3 * 0.4 + py * -0.2 + rz3 * 0.85) / Math.sqrt(0.16 + 0.04 + 0.7225);
        const light2 =
          Math.max(0, rx3 * -0.3 + py * -0.4 + rz3 * 0.5) / Math.sqrt(0.09 + 0.16 + 0.25);
        const lighting = light1 * 0.7 + light2 * 0.3;

        const theta = Math.atan2(py, rx3);
        const phi = Math.atan2(rz3, Math.sqrt(rx3 * rx3 + py * py));

        const s1 = Math.sin(theta * 7 + phi * 3) * 0.5 + 0.5;
        const s2 = Math.sin(theta * 4 - phi * 6 + 1.2) * 0.5 + 0.5;
        const s3 = Math.sin(theta * 9 + phi * 5 + 0.5) * 0.5 + 0.5;

        let folds = 0;
        if (s1 > 0.78) folds = Math.max(folds, (s1 - 0.78) * 4.5);
        if (s2 > 0.8) folds = Math.max(folds, (s2 - 0.8) * 4);
        if (s3 > 0.82) folds = Math.max(folds, (s3 - 0.82) * 3.5);

        if (Math.abs(rx3) < 0.05 && rz3 > 0) {
          folds = Math.max(folds, 0.7 * (1 - Math.abs(rx3) / 0.05));
        }

        let density = 0.2 + lighting * 0.5 + folds * 0.45;
        const rim = (1 - Math.max(0, rz3)) ** 2;
        density += rim * 0.35;

        const seed = y * cols + x;
        const noise = seededRandom(seed + Math.floor(time * 1.5) * 0.01) * 0.04;
        density = Math.max(0, Math.min(1, density - noise));

        const ci = Math.min(CHARS.length - 1, Math.floor(density * CHARS.length));
        const char = CHARS[ci];

        if (char === " ") {
          html += " ";
        } else {
          const alpha = 0.25 + (ci / CHARS.length) * 0.7;
          html += `<span style="color:rgba(${ACCENT},${alpha})">${char === "&" ? "&amp;" : char}</span>`;
        }
      } else {
        html += " ";
      }
    }
    html += "</div>";
  }
  return html;
}

function MindBrain() {
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let frame: number;
    const start = Date.now();
    const tick = () => {
      const time = (Date.now() - start) / 1000;
      if (preRef.current) {
        preRef.current.innerHTML = generateBrainHTML(time);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return <pre ref={preRef} className="font-mono text-[6.5px] leading-[1.15] sm:text-[7.5px]" />;
}

const DOCS = [
  {
    label: "our strategy",
    ascii: `┌───────────────────┐\n│ § our strategy     │\n│───────────────────│\n│ GTM focus: devs    │\n│ pricing: usage     │\n│ moat: open source  │\n└───────────────────┘`,
    x: 8,
    y: 5,
  },
  {
    label: "value prop",
    ascii: `┌────────────────────┐\n│ § value prop        │\n│────────────────────│\n│ agents that work    │\n│ no infra needed     │\n│ your data, yours    │\n└────────────────────┘`,
    x: 68,
    y: 3,
  },
  {
    label: "cold outreach",
    ascii: `┌─────────────────────┐\n│ § cold outreach      │\n│─────────────────────│\n│ subject: hey {name}  │\n│ hook: 3 agents       │\n│ cta: 15min call      │\n└─────────────────────┘`,
    x: 65,
    y: 72,
  },
  {
    label: "onboarding",
    ascii: `┌───────────────────┐\n│ § onboarding       │\n│───────────────────│\n│ 1. create brain    │\n│ 2. add context     │\n│ 3. type #agent     │\n└───────────────────┘`,
    x: 5,
    y: 70,
  },
];

function FloatingDoc({
  ascii,
  baseX,
  baseY,
  seed,
  visible,
  updated,
}: {
  ascii: string;
  baseX: number;
  baseY: number;
  seed: number;
  visible: boolean;
  updated: boolean;
}) {
  return (
    <div
      className={`absolute font-mono text-[7.5px] leading-[1.35] transition-opacity duration-1000 sm:text-[8.5px] ${
        visible ? "opacity-100" : "opacity-0"
      }`}
      style={{
        left: `${baseX}%`,
        top: `${baseY}%`,
        animation: "mind-wobble 18s ease-in-out infinite",
        animationDelay: `${seed * -2.5}s`,
      }}
    >
      <pre
        className={`whitespace-pre transition-colors duration-500 ${
          updated
            ? "text-violet-500 dark:text-violet-400"
            : "text-zinc-500/60 dark:text-zinc-500/40"
        }`}
      >
        {ascii}
      </pre>
      {updated && (
        <span className="-right-1 -top-2 absolute animate-pulse font-mono text-[8px] text-violet-500 dark:text-violet-400">
          ● write
        </span>
      )}
    </div>
  );
}

function AgentBox({
  name,
  active,
  activeLabel,
  idleLabel,
}: {
  name: string;
  active: boolean;
  activeLabel: string;
  idleLabel: string;
}) {
  const width = Math.max(name.length + 4, activeLabel.length + 4, idleLabel.length + 4);
  const border = "─".repeat(width);
  const pad = (s: string) => s.padEnd(width - 2);

  const content = active
    ? `┌─${border}┐\n│ #agent ${pad(name)}│\n│─${border}│\n│ ${pad(`▸ ${activeLabel}`)}│\n└─${border}┘`
    : `┌─${border}┐\n│ #agent ${pad(name)}│\n│─${border}│\n│ ${pad(idleLabel)}│\n└─${border}┘`;

  return (
    <pre
      className={`whitespace-pre transition-colors duration-500 ${
        active ? "text-violet-500 dark:text-violet-400" : "text-zinc-400/50 dark:text-zinc-600/50"
      }`}
    >
      {content}
    </pre>
  );
}

export function MindVisual() {
  const [visibleDocs, setVisibleDocs] = useState([0, 1, 2]);
  const [updatedDoc, setUpdatedDoc] = useState<number | null>(null);
  const [activeAgent, setActiveAgent] = useState<"none" | "researcher" | "coceo">("none");
  const visibleDocsRef = useRef(visibleDocs);
  visibleDocsRef.current = visibleDocs;
  const cycleRef = useRef(0);

  const run = useCallback(() => {
    const agent = cycleRef.current % 2 === 0 ? "researcher" : "coceo";
    cycleRef.current += 1;
    setActiveAgent(agent);

    const t1 = setTimeout(() => {
      const vis = visibleDocsRef.current;
      const target = vis[Math.floor(Math.random() * vis.length)];
      if (target !== undefined) setUpdatedDoc(target);
    }, 1500);

    const t2 = setTimeout(() => {
      setActiveAgent("none");
      setUpdatedDoc(null);
    }, 4500);

    const t3 = setTimeout(() => {
      setVisibleDocs((prev) => {
        const allIndices = [0, 1, 2, 3];
        const hidden = allIndices.filter((i) => !prev.includes(i));
        const addIdx = hidden[Math.floor(Math.random() * hidden.length)];
        if (addIdx === undefined) return prev;
        const removeIdx = Math.floor(Math.random() * prev.length);
        const next = [...prev];
        next[removeIdx] = addIdx;
        return next;
      });
    }, 6500);

    return [t1, t2, t3];
  }, []);

  useEffect(() => {
    const timers = run();
    const interval = setInterval(() => {
      run();
    }, 8000);
    return () => {
      clearInterval(interval);
      timers.forEach(clearTimeout);
    };
  }, [run]);

  const researcherActive = activeAgent === "researcher";
  const coceoActive = activeAgent === "coceo";
  const anyActive = activeAgent !== "none";

  const lineActive = `rgba(${ACCENT},0.5)`;
  const lineIdle = `rgba(${ACCENT},0.12)`;

  return (
    <div className="relative w-full overflow-hidden" style={{ minHeight: 500 }} aria-hidden="true">
      <style dangerouslySetInnerHTML={{ __html: WOBBLE_KEYFRAMES }} />
      {/* Co-CEO agent — top center */}
      <div className="-translate-x-1/2 absolute top-4 left-1/2 z-10 font-mono text-[8px] sm:text-[9px]">
        <AgentBox
          name="co-ceo"
          active={coceoActive}
          activeLabel="reviewing strategy..."
          idleLabel="  watching"
        />
      </div>

      {/* Brain — dead center */}
      <div className="-translate-x-1/2 -translate-y-1/2 absolute top-1/2 left-1/2 z-10">
        <div className="relative">
          <MindBrain />
          <span className="-translate-x-1/2 -translate-y-1/2 absolute top-1/2 left-1/2 z-10 bg-card/80 px-2 py-0.5 font-medium font-serif text-[10px] text-foreground tracking-wide sm:text-xs">
            Brain
          </span>
        </div>
      </div>

      {/* Signal lines */}
      <svg
        className="pointer-events-none absolute inset-0 z-[5] size-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        fill="none"
      >
        {/* Lines from brain to docs */}
        {DOCS.map((doc, i) => {
          const ex = doc.x + 12;
          const ey = doc.y + 6;
          const isUpdating = anyActive && updatedDoc === i;
          const isVisible = visibleDocs.includes(i);
          return (
            <line
              key={doc.label}
              x1="50"
              y1="50"
              x2={ex}
              y2={ey}
              stroke={isUpdating ? lineActive : lineIdle}
              strokeWidth={isUpdating ? "0.35" : "0.2"}
              strokeDasharray="1.5 2"
              opacity={isVisible ? 1 : 0}
              style={{ transition: "stroke 0.5s, stroke-width 0.5s, opacity 1s" }}
            />
          );
        })}

        {/* Line from co-ceo (top) to brain */}
        <line
          x1="50"
          y1="50"
          x2="50"
          y2="10"
          stroke={coceoActive ? lineActive : lineIdle}
          strokeWidth={coceoActive ? "0.35" : "0.2"}
          strokeDasharray="1.5 2"
          style={{ transition: "stroke 0.5s, stroke-width 0.5s" }}
        />

        {/* Line from researcher (bottom) to brain */}
        <line
          x1="50"
          y1="50"
          x2="50"
          y2="92"
          stroke={researcherActive ? lineActive : lineIdle}
          strokeWidth={researcherActive ? "0.35" : "0.2"}
          strokeDasharray="1.5 2"
          style={{ transition: "stroke 0.5s, stroke-width 0.5s" }}
        />
      </svg>

      {/* Floating ASCII doc cards */}
      {DOCS.map((doc, i) => (
        <FloatingDoc
          key={doc.label}
          ascii={doc.ascii}
          baseX={doc.x}
          baseY={doc.y}
          seed={i}
          visible={visibleDocs.includes(i)}
          updated={updatedDoc === i}
        />
      ))}

      {/* Researcher agent — bottom center */}
      <div className="-translate-x-1/2 absolute bottom-4 left-1/2 z-10 font-mono text-[8px] sm:text-[9px]">
        <AgentBox
          name="researcher"
          active={researcherActive}
          activeLabel="updating doc..."
          idleLabel="  idle"
        />
      </div>
    </div>
  );
}
