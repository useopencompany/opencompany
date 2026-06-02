// Tracks which skills a session has read via `read_skill`, so skill-gated tools (currently
// `update_agent_file`) can require the agent to read the relevant SKILL.md before acting.
//
// State is intentionally in-memory and keyed by sessionId. One message turn runs in a single
// process with sequential tool calls sharing a sessionId, so a within-turn read → edit always
// satisfies the gate; because we never clear entries, cross-turn reads within the same
// long-lived runner process are remembered too. The only edge case — a runner restart or a
// different runner instance handling a later turn — simply re-gates the agent into one extra
// `read_skill` call, which is cheap and correct. We accept that over a DB query on every edit.
const readSkillsBySession = new Map<string, Set<string>>();

// Record that `skillId` was successfully read in `sessionId`.
export function markSkillRead(sessionId: string, skillId: string): void {
  if (!sessionId || !skillId) return;
  let read = readSkillsBySession.get(sessionId);
  if (!read) {
    read = new Set();
    readSkillsBySession.set(sessionId, read);
  }
  read.add(skillId);
}

// Whether `skillId` has been read in `sessionId`.
export function hasReadSkill(sessionId: string, skillId: string): boolean {
  return readSkillsBySession.get(sessionId)?.has(skillId) ?? false;
}

// Test-only: reset all tracked reads so suites don't leak state between cases.
export function resetSkillReadsForTests(): void {
  readSkillsBySession.clear();
}
