import { ChevronDown } from "lucide-react";

type AgentOption = {
  id: string;
  name: string;
};

function Prompt({ agents }: { agents: AgentOption[] }) {
  return (
    <div className="rounded-xl border border-[#e4e4e0] bg-white px-4 pt-3.5 pb-2.5 shadow-[0_1px_2px_rgba(15,15,15,0.03),0_0_0_1px_rgba(15,15,15,0.01)] transition-shadow duration-200 focus-within:border-[#d4d4cf] focus-within:shadow-[0_1px_2px_rgba(15,15,15,0.04),0_0_0_3px_rgba(15,15,15,0.04)]">
      <input
        type="text"
        placeholder="Ask Open Company to build, fix bugs, explore"
        className="w-full bg-transparent text-[14px] leading-6 tracking-[-0.005em] text-ink placeholder:text-ink-subtle outline-none"
      />
      <div className="mt-6 flex items-center">
        <label className="sr-only" htmlFor="agent-select">
          Agent
        </label>
        <div className="relative">
          <select
            id="agent-select"
            disabled={agents.length === 0}
            className="h-7 max-w-[240px] appearance-none rounded-md bg-transparent py-1 pl-1.5 pr-6 text-[12.5px] text-ink/90 outline-none transition-colors duration-150 hover:bg-[#f3f3f0] focus:bg-[#f3f3f0] focus-visible:ring-1 focus-visible:ring-ink/20 disabled:text-ink-subtle"
            defaultValue={agents.at(0)?.id ?? ""}
          >
            {agents.length === 0 ? (
              <option value="">No agents available</option>
            ) : (
              agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))
            )}
          </select>
          <ChevronDown
            size={12}
            strokeWidth={1.75}
            className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-muted"
          />
        </div>
      </div>
    </div>
  );
}

export default function MainPanel({ agents }: { agents: AgentOption[] }) {
  return (
    <main className="relative flex h-full flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[680px] px-6 pt-10">
        <Prompt agents={agents} />
      </div>
    </main>
  );
}
