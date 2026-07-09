// The pointer/copy contract: how brain writers cite external sources. The
// canonical prose lives in apps/goat/docs/pointer-copy-contract.md; this
// constant is the prompt-ready form every brain writing agent must embed so
// the enforced rule and the documented rule cannot drift apart.
export const GOAT_BRAIN_POINTER_COPY_RULE = [
  "Pointers over copies. Every claim you write into the brain has three parts:",
  "1. The claim itself, in compiled truth or a timeline entry.",
  "2. A source pointer: a [[source:provider:id|Label]] inline link or a timeline --source-ref. Source refs are provider:id (lowercase provider slug, colon, then the provider's identifier — e.g. jamie:meeting:calendar_event_123, gmail:thread_456, linear:issue_ABC-12).",
  "3. A content snapshot in evidence/ ONLY when the source is ephemeral or has no canonical live home.",
  "Per source class:",
  "- Meeting transcripts and call recordings: snapshot into evidence/. Pages link the evidence record; never inline the transcript.",
  "- Emails: snapshot into evidence/.",
  "- Tracked work items (Linear issues, GitHub issues and pull requests): pointer plus a one-line current-state summary. Never copy the body — the tracker is the canonical live home and copies go stale immediately.",
  "- Anything else: pointer only by default; snapshot only if the content could not be re-fetched later.",
].join("\n");
