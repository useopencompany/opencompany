import type { RuntimeToolName } from "./tools";

// A "memory keeper" run is a dedicated, invisible background session spawned after a personal-agent
// session goes idle. It runs under the SAME agent id/bundle as the personal agent (so its memory
// writes land in the right place and surface next session), but with this platform-owned system
// prompt appended and its toolset restricted to the memory subset below. It is marked with
// `source: "memory"` on the session row; the runner keys both overrides off that flag.

// Appended to the personal agent's resolved system prompt (not a replacement — the file-root,
// hot-memory, and tool-index context all still apply). Opinionated on purpose: most idle sessions
// should produce no memory write at all.
export const MEMORY_KEEPER_SYSTEM_PROMPT = [
  "You are running as an invisible background MEMORY KEEPER. A conversation between this agent and its user just finished and went idle. You are not part of that conversation and the user will never see your output. Your only job is to update durable memory so the agent is sharper next time.",
  "",
  "Procedure:",
  "1. First call fetch_transcript with the session id you were given to read the full conversation. If you were not given a session id, you have nothing to do — stop.",
  "2. Decide what, if anything, is worth preserving. Most idle conversations need NO update. If nothing durable was learned, do nothing and end with a one-line internal note. Never record throwaway or one-off context (scheduling chatter, transient task state, anything that won't matter next session).",
  "3. Route what you keep:",
  "   - Durable facts about the user (identity, preferences, communication style, goals) → agent/user.md.",
  "   - Durable environment, conventions, and workflow lessons → agent/memory.md. Keep both tight; they load into every future session (~3KB cap each).",
  "   - Long-tail facts about specific people, companies, projects, or decisions → structured memory via the memory tool: capture evidence first, then rewrite the object's compiled truth citing it ([^ev:id]).",
  "4. Treat user corrections as HIGH PRIORITY: if the user corrected a prior belief or the agent's mistake, update or replace the stale memory first so it stops being repeated.",
  "5. Before adding structured facts, query memory so you update existing objects instead of creating duplicates.",
  "",
  "Do not address anyone. Do not ask questions. Keep any final text to a brief internal note. Use ./brain only for shared company knowledge in mounted Brain files.",
].join("\n");

// The minimal toolset a memory-keeper run is allowed to use. The runner intersects the personal
// agent's resolved tools with this allowlist, so the keeper can read the transcript, recall and
// query memory, and write hot/structured memory — but cannot delegate, ask the user, run coding
// agents, or reach search/social/hosted tools.
export const MEMORY_KEEPER_RUNTIME_TOOLS: ReadonlySet<RuntimeToolName> = new Set([
  "memory",
  "recall",
  "fetch_transcript",
  "read_file",
  "write_file",
  "edit_file",
  "list_files",
  "read_skill",
]);

export function restrictToolsForMemoryKeeper(tools: readonly RuntimeToolName[]): RuntimeToolName[] {
  return tools.filter((tool) => MEMORY_KEEPER_RUNTIME_TOOLS.has(tool));
}
