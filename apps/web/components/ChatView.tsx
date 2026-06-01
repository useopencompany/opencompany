import {
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  FileText,
  GitBranch,
  Image as ImageIcon,
  Plus,
} from "lucide-react";

function HeaderBar() {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border-subtle bg-canvas/85 px-8 py-3 backdrop-blur-md">
      <span className="text-[13px] font-medium tracking-[-0.005em] text-ink">
        Development environment setup
      </span>
      <span className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[12px] text-ink-muted">
        <GitBranch size={11} strokeWidth={1.75} className="text-ink-muted" />
        <span>acta/acta-website</span>
      </span>
    </div>
  );
}

function UserMessage() {
  return (
    <div className="flex justify-end">
      <div className="max-w-[78%] rounded-2xl rounded-tr-md bg-surface-selected px-3.5 py-2.5 text-[13px] leading-[1.55] tracking-[-0.005em] text-ink shadow-[0_1px_0_rgba(0,0,0,0.02)]">
        Please set up the development environment for this codebase. Run the application(s) and
        demonstrate that the environment is working.
      </div>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-[5px] border border-border-subtle bg-surface-muted px-1.5 py-[1px] font-mono text-[11.5px] text-ink/90">
      {children}
    </code>
  );
}

function Screenshot({ tone }: { tone: "dark" | "light" | "neutral" }) {
  const bg =
    tone === "dark"
      ? "linear-gradient(135deg, #0b0f1a 0%, #1c2236 60%, #2a3252 100%)"
      : tone === "light"
        ? "linear-gradient(135deg, #ffffff 0%, #f1f3f7 60%, #e3e6ee 100%)"
        : "linear-gradient(135deg, #fafaf6 0%, #efeee7 60%, #e2e0d2 100%)";
  return (
    <div className="relative aspect-[16/10] overflow-hidden rounded-md border border-border shadow-[0_1px_2px_rgba(15,15,15,0.04)]">
      <div className="absolute inset-0" style={{ background: bg }} />
      {/* faux browser chrome */}
      <div className="absolute inset-x-0 top-0 flex items-center gap-1 px-2 py-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-surface/30" />
        <span className="h-1.5 w-1.5 rounded-full bg-surface/30" />
        <span className="h-1.5 w-1.5 rounded-full bg-surface/30" />
      </div>
      {/* faux content shimmer */}
      <div className="absolute inset-x-3 top-6 flex flex-col gap-1.5">
        <div className="h-1.5 w-1/3 rounded bg-surface/15" />
        <div className="h-1.5 w-2/3 rounded bg-surface/10" />
        <div className="h-1.5 w-1/2 rounded bg-surface/10" />
      </div>
    </div>
  );
}

function CheckTable() {
  const rows: Array<{ check: string; command: React.ReactNode; result: React.ReactNode }> = [
    {
      check: "Dependencies",
      command: <Code>bun install</Code>,
      result: "903 packages",
    },
    {
      check: "PostgreSQL",
      command: <Code>docker compose up -d</Code>,
      result: "Running on port 54320",
    },
    {
      check: "Dev server",
      command: <Code>bun run dev</Code>,
      result: "Running on port 3000",
    },
    {
      check: "Lint",
      command: <Code>bun run lint</Code>,
      result: "Passes (pre-existing warnings only).",
    },
    {
      check: "Integration tests",
      command: <Code>POSTGRES_URL=…payload_test bun run test:int</Code>,
      result: "1/1 passed",
    },
    {
      check: "E2E tests",
      command: <Code>bun run test:e2e</Code>,
      result: "1/1 passed",
    },
    {
      check: "Hello world",
      command: "Created admin user, seeded DB, verified frontend + admin panel",
      result: "Working",
    },
  ];
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr className="border-b border-border-subtle bg-surface-muted text-left text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
            <th className="px-3 py-2 font-medium">Check</th>
            <th className="px-3 py-2 font-medium">Command</th>
            <th className="px-3 py-2 font-medium">Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-border-subtle last:border-b-0 align-top">
              <td className="px-3 py-2.5 text-ink/90">{row.check}</td>
              <td className="px-3 py-2.5">{row.command}</td>
              <td className="px-3 py-2.5 text-ink/85">{row.result}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TestRow({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <CheckCircle2 size={14} strokeWidth={1.75} className="mt-[2px] shrink-0 text-success" />
      <span className="text-[13px] leading-[1.55] tracking-[-0.005em] text-ink/90">{children}</span>
    </li>
  );
}

function FilesChanged() {
  const files = [
    { name: "AGENTS.md", added: 33, removed: 0 },
    { name: "docker-compose.yml", added: 1, removed: 1 },
    { name: "bun.lock", added: 10417, removed: 0 },
  ];
  return (
    <details
      open
      className="group rounded-lg border border-border bg-surface shadow-[0_1px_0_rgba(0,0,0,0.02)]"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[12.5px] text-ink/90">
        <ChevronDown
          size={13}
          strokeWidth={2}
          className="-rotate-90 text-ink-muted transition-transform duration-150 group-open:rotate-0"
        />
        <span className="font-medium">3 Files Changed</span>
      </summary>
      <div className="border-t border-border-subtle">
        {files.map((f, i) => (
          <div
            key={f.name}
            className={`flex items-center gap-2 px-3 py-2 text-[12.5px] ${
              i !== files.length - 1 ? "border-b border-border-subtle" : ""
            }`}
          >
            <FileText size={12} strokeWidth={1.75} className="text-ink-muted" />
            <span className="text-ink/90">{f.name}</span>
            <span className="ml-auto flex items-center gap-2 font-medium tabular-nums">
              {f.removed > 0 && <span className="text-danger">−{f.removed}</span>}
              <span className="text-success">+{f.added.toLocaleString()}</span>
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}

function FollowUp() {
  return (
    <div className="mt-6 space-y-2">
      <div className="flex items-center">
        <button className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-[12px] text-ink/90 transition-colors duration-150 hover:bg-surface-muted">
          Save environment
        </button>
      </div>
      <div className="rounded-xl border border-border bg-surface px-3.5 pt-2.5 pb-2 shadow-[0_1px_2px_rgba(15,15,15,0.03)] transition-shadow duration-200 focus-within:border-border-strong focus-within:shadow-[0_1px_2px_rgba(15,15,15,0.04),0_0_0_3px_rgba(15,15,15,0.04)]">
        <input
          type="text"
          placeholder="Add follow up for setup agent"
          className="w-full bg-transparent text-[13px] tracking-[-0.005em] text-ink placeholder:text-ink-subtle outline-none"
        />
        <div className="mt-2 flex items-center gap-1.5">
          <button className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-ink/85 transition-colors duration-150 hover:bg-surface-hover">
            <span>GPT-5.5 High</span>
            <ChevronDown size={12} strokeWidth={1.75} className="text-ink-muted" />
          </button>
          <div className="flex items-center">
            <span className="relative inline-flex h-5 w-5 items-center justify-center rounded-full border border-surface bg-ink text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.12)]">
              <Plus size={11} strokeWidth={2.25} />
            </span>
            <span
              aria-hidden
              className="-ml-1.5 h-5 w-5 rounded-full border border-surface shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
              style={{
                background:
                  "radial-gradient(circle at 35% 30%, #ffffff 0%, #d0d0cf 30%, #1a1a1a 80%)",
              }}
            />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <button className="rounded-md p-1.5 text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink">
              <ImageIcon size={14} strokeWidth={1.75} />
            </button>
            <button className="flex h-7 w-7 items-center justify-center rounded-full bg-ink text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85">
              <ArrowUp size={13} strokeWidth={2.25} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ChatView() {
  return (
    <main className="relative flex h-full flex-1 flex-col overflow-y-auto">
      <HeaderBar />
      <div className="mx-auto w-full max-w-[720px] px-8 pb-12 pt-6">
        <UserMessage />

        {/* Assistant response */}
        <article className="mt-6 space-y-5 text-[13px] leading-[1.65] tracking-[-0.005em] text-ink/90">
          {/* Screenshots */}
          <div className="grid grid-cols-3 gap-2">
            <Screenshot tone="dark" />
            <Screenshot tone="light" />
            <Screenshot tone="neutral" />
          </div>

          <p>
            Full demo: homepage, blog posts, admin dashboard, and post editor with Lexical rich
            text.
          </p>

          <section className="space-y-2">
            <h3 className="text-[13px] font-semibold tracking-[-0.005em] text-ink">Summary</h3>
            <ul className="space-y-1.5 pl-4 [&>li]:list-disc [&>li]:marker:text-ink-subtle">
              <li>
                Added <Code>AGENTS.md</Code> with local and Cloud development instructions covering
                services, key commands, and non-obvious caveats.
              </li>
              <li>
                Update script set to <Code>bun install</Code> +{" "}
                <Code>bunx playwright install chromium</Code> (minimal dependency refresh).
              </li>
            </ul>
          </section>

          <p>
            <span className="font-semibold text-ink">What was set up:</span> Payload CMS 3.x +
            Website Template (Next.js 15 + Payload CMS + PostgreSQL via Docker Compose).
          </p>

          <CheckTable />

          <section className="space-y-2">
            <h3 className="text-[13px] font-semibold tracking-[-0.005em] text-ink">Testing</h3>
            <ul className="space-y-1.5">
              <TestRow>
                <Code>bun run lint</Code> — passes with pre-existing warnings
              </TestRow>
              <TestRow>
                <Code>bun run test:int</Code> — 1 test passed (using separate{" "}
                <Code>payload_test</Code> database)
              </TestRow>
              <TestRow>
                <Code>bun run test:e2e</Code> — 1 Playwright test passed (Chromium)
              </TestRow>
              <TestRow>
                <Code>curl -I http://localhost:3000</Code> — 200 OK, X-Powered-By: Next.js, Payload
              </TestRow>
              <TestRow>
                Manual GUI testing — homepage, blog listing, admin login, post editing all
                functional
              </TestRow>
            </ul>
          </section>

          <p>
            Please merge the <Code>AGENTS.md</Code> changes so future agents remember the
            development setup caveats (especially the separate test database requirement).
          </p>

          <p className="text-[12px] text-ink-subtle">Worked for 2m 5s</p>

          <FilesChanged />
        </article>

        <FollowUp />
      </div>
    </main>
  );
}
