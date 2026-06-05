// Decides which sidebar indicator dot a session row should render. Kept as a
// pure function so the green "active" vs blue "unseen-finished" rules are unit
// tested in isolation from React.
//
//   "status" — show the live <SessionStatusDot status> (green/amber pulse): the
//              session is actively working or interrupted.
//   "unseen" — show the blue "finished while you were away" dot (PRO-142).
//   null     — no dot.

export type SidebarDotKind = "status" | "unseen" | null;

// Mirror of the statuses the sidebar has always lit a status dot for. Kept here
// so the dot rules live in one tested place.
const ACTIVE_DOT_STATUSES = new Set([
  "running",
  "provisioning",
  "awaiting_approval",
  "awaiting_input",
  "interrupted",
]);

// Terminal "there's a result to look at" statuses that can go blue when unseen.
const UNSEEN_DOT_STATUSES = new Set(["completed", "failed"]);

export function sidebarDotKind(input: {
  status: string;
  updatedAt: string;
  seenAt: string | null;
  isOpen: boolean;
}): SidebarDotKind {
  if (ACTIVE_DOT_STATUSES.has(input.status)) return "status";

  if (UNSEEN_DOT_STATUSES.has(input.status) && !input.isOpen) {
    // Unseen if never viewed, or viewed before this session last changed (i.e.
    // it finished after you last looked). updatedAt is the finish time for a
    // terminal session — nothing writes the row after the lease clears.
    if (input.seenAt === null) return "unseen";
    if (Date.parse(input.seenAt) < Date.parse(input.updatedAt)) return "unseen";
  }

  return null;
}
