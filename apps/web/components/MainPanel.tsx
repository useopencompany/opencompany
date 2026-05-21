import {
  ChevronDown,
  CircleCheck,
  Flag,
  GitBranch,
  Image as ImageIcon,
  Mic,
  Plus,
} from "lucide-react";

function RepoChip({ label }: { label: string }) {
  return (
    <button className="flex items-center gap-1 rounded-md px-2 py-1 text-[12.5px] text-ink/90 transition-colors duration-150 hover:bg-[#ececea] hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20">
      <span className="tracking-[-0.005em]">{label}</span>
      <ChevronDown size={13} strokeWidth={1.75} className="text-ink-muted" />
    </button>
  );
}

function Prompt() {
  return (
    <div className="rounded-xl border border-[#e4e4e0] bg-white px-4 pt-3.5 pb-2.5 shadow-[0_1px_2px_rgba(15,15,15,0.03),0_0_0_1px_rgba(15,15,15,0.01)] transition-shadow duration-200 focus-within:border-[#d4d4cf] focus-within:shadow-[0_1px_2px_rgba(15,15,15,0.04),0_0_0_3px_rgba(15,15,15,0.04)]">
      <input
        type="text"
        placeholder="Ask Open Company to build, fix bugs, explore"
        className="w-full bg-transparent text-[14px] leading-6 tracking-[-0.005em] text-ink placeholder:text-ink-subtle outline-none"
      />
      <div className="mt-6 flex items-center gap-2">
        <button className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[12.5px] text-ink/90 transition-colors duration-150 hover:bg-[#f3f3f0] hover:text-ink">
          <span>GPT-5.5 High</span>
          <ChevronDown size={12} strokeWidth={1.75} className="text-ink-muted" />
        </button>

        {/* Stacked icon group */}
        <div className="flex items-center">
          <span className="relative inline-flex h-5 w-5 items-center justify-center rounded-full border border-white bg-[#0e1320] text-white shadow-[0_1px_2px_rgba(0,0,0,0.12)]">
            <Plus size={11} strokeWidth={2.25} />
          </span>
          <span
            aria-hidden
            className="-ml-1.5 h-5 w-5 rounded-full border border-white shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
            style={{
              background:
                "radial-gradient(circle at 35% 30%, #ffffff 0%, #d0d0cf 30%, #1a1a1a 80%)",
            }}
          />
          <button className="ml-1 rounded p-0.5 text-ink-muted transition-colors duration-150 hover:bg-[#f3f3f0] hover:text-ink">
            <ChevronDown size={12} strokeWidth={1.75} />
          </button>
        </div>

        {/* Green pill */}
        <button className="ml-1 flex items-center gap-1.5 rounded-full bg-[#e6f3ea] px-2.5 py-1 text-[12px] font-medium text-[#1f7a3a] ring-1 ring-inset ring-[#cfe6d6] transition-colors duration-150 hover:bg-[#ddeee2]">
          <Flag size={11} strokeWidth={2} />
          <span>Enable agent demos</span>
        </button>

        <div className="ml-auto flex items-center gap-1">
          <button className="rounded-md p-1.5 text-ink-muted transition-colors duration-150 hover:bg-[#f3f3f0] hover:text-ink">
            <ImageIcon size={14} strokeWidth={1.75} />
          </button>
          <button className="flex h-7 w-7 items-center justify-center rounded-full bg-[#111] text-white shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-black">
            <Mic size={13} strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
}

function SuggestionPills() {
  return (
    <div className="mt-3 flex items-center gap-2">
      <button className="flex items-center gap-2 rounded-full border border-[#e4e4e0] bg-white px-3 py-1 text-[12.5px] text-ink/90 transition-colors duration-150 hover:bg-[#fafaf8] hover:text-ink">
        <span>Try Commands</span>
        <span className="rounded border border-[#e6e6e3] bg-[#f4f4f1] px-1.5 py-[1px] font-mono text-[10.5px] text-ink-muted">
          /
        </span>
      </button>
      <button className="rounded-full border border-[#e4e4e0] bg-white px-3 py-[5px] text-[12.5px] text-ink/90 transition-colors duration-150 hover:bg-[#fafaf8] hover:text-ink">
        Run security audit
      </button>
    </div>
  );
}

function DraftThumb() {
  return (
    <div className="relative h-[88px] w-[120px] shrink-0">
      {/* back stacked sheet */}
      <div className="absolute left-2 top-2 h-[78px] w-[110px] rounded-md border border-[#e6e6e3] bg-white" />
      {/* front sheet */}
      <div className="relative h-[78px] w-[110px] overflow-hidden rounded-md border border-[#e4e4e0] bg-white shadow-[0_1px_2px_rgba(15,15,15,0.04)]">
        <div className="flex items-center justify-between px-2 pt-2 text-[10px]">
          <span className="text-ink-muted">3 files</span>
          <span className="flex items-center gap-1 font-medium tabular-nums">
            <span className="text-[#16a34a]">+10451</span>
            <span className="text-[#dc2626]">−1</span>
          </span>
        </div>
        <div className="mt-1 px-2">
          <div className="h-px w-full bg-[#efefec]" />
        </div>
        <div className="mt-4 flex items-center justify-center">
          <span className="inline-flex items-center gap-1 rounded-full bg-[#f0f0ec] px-2 py-[3px] text-[10.5px] text-ink">
            <GitBranch size={9} strokeWidth={2} />
            Draft
          </span>
        </div>
      </div>
    </div>
  );
}

function BranchThumb() {
  return (
    <div className="flex h-[88px] w-[120px] shrink-0 items-center justify-center rounded-md border border-[#e4e4e0] bg-[#f4f4f1]">
      <span className="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-[11px] text-ink shadow-[0_0_0_1px_#e6e6e3,0_1px_2px_rgba(15,15,15,0.03)]">
        <GitBranch size={10} strokeWidth={2} />
        Branch
      </span>
    </div>
  );
}

function AgentCard({
  thumb,
  title,
  dot,
  iconLeft,
  meta,
}: {
  thumb: React.ReactNode;
  title: string;
  dot?: boolean;
  iconLeft: React.ReactNode;
  meta: { label: string; repo: string; age: string };
}) {
  return (
    <button className="group flex w-full items-center gap-4 rounded-lg px-2 py-2 text-left transition-colors duration-150 hover:bg-[#ececea]/70 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/15">
      {thumb}
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-[13.5px] font-medium tracking-[-0.005em] text-ink">{title}</span>
          {dot && (
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#16a34a] shadow-[0_0_0_2px_rgba(22,163,74,0.12)]" />
          )}
        </div>
        <div className="flex items-center gap-2 text-[12px] text-ink-muted">
          <span className="flex items-center gap-1">
            {iconLeft}
            <span className="text-ink/85">{meta.label}</span>
          </span>
          <span aria-hidden className="h-0.5 w-0.5 rounded-full bg-ink-subtle/60" />
          <span className="text-ink-muted">{meta.repo}</span>
          <span aria-hidden className="h-0.5 w-0.5 rounded-full bg-ink-subtle/60" />
          <span className="text-ink-subtle">{meta.age}</span>
        </div>
      </div>
    </button>
  );
}

export default function MainPanel({ workspaceName }: { workspaceName: string }) {
  return (
    <main className="relative flex h-full flex-1 flex-col overflow-y-auto">
      {/* Centered column */}
      <div className="mx-auto w-full max-w-[680px] px-6 pt-10">
        {/* Repo / branch row */}
        <div className="mb-3 flex items-center gap-1">
          <RepoChip label={workspaceName} />
          <RepoChip label="main" />
        </div>

        {/* Prompt box */}
        <Prompt />

        {/* Suggestions */}
        <SuggestionPills />

        {/* Cards */}
        <div className="mt-8 flex flex-col gap-0.5">
          <AgentCard
            thumb={<DraftThumb />}
            title="Development environment setup"
            dot
            iconLeft={<GitBranch size={11} strokeWidth={1.75} className="text-ink-muted" />}
            meta={{ label: "Setup", repo: "acta-website", age: "1d" }}
          />
          <AgentCard
            thumb={<BranchThumb />}
            title="Current work understanding"
            iconLeft={<CircleCheck size={11} strokeWidth={1.75} className="text-ink-muted" />}
            meta={{ label: "GPT-5.5 High", repo: "acta-website", age: "5d" }}
          />
        </div>
      </div>
    </main>
  );
}
