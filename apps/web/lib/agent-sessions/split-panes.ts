// Split-view URL state: the route segment (`/company/session/<id>`) is the primary
// (leftmost) pane; the `?split=` query param carries the ordered, comma-separated ids
// of the secondary panes rendered alongside it. Total panes (primary + split) are
// capped at MAX_PANES.

export const MAX_PANES = 4;

// Parse a `?split=` query value into the ordered, deduped list of secondary session
// ids. Drops blanks, the primary id, and duplicates, then caps the result so the
// total pane count (primary + secondaries) never exceeds MAX_PANES. Purely structural:
// it does not check whether an id refers to a real session — an unknown id still parses
// through and is surfaced as an error pane at render time.
export function parseSplitParam(
  raw: string | string[] | undefined | null,
  primaryId: string,
): string[] {
  const joined = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
  const tokens = joined
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  const seen = new Set<string>([primaryId]);
  const result: string[] = [];
  for (const id of tokens) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= MAX_PANES - 1) break;
  }
  return result;
}

// Serialize secondary pane ids back into a `?split=` value, or null to omit the param
// entirely when there are no secondary panes.
export function serializeSplitParam(secondaryIds: string[]): string | null {
  return secondaryIds.length > 0 ? secondaryIds.join(",") : null;
}

// Build the href for a given pane layout by swapping the trailing session-id segment of
// the current pathname and appending `?split=` when there are secondary panes. Deriving
// the base from the live pathname (instead of hardcoding "/company/session") keeps the
// helper reusable for the /personal session route.
// Preconditions: the current session id must be the trailing path segment and the
// pathname must have no trailing slash — both hold for Next's usePathname() on the
// /company/session/[id] and /personal/session/[id] routes this is called from.
export function buildSplitViewHref(
  pathname: string,
  primaryId: string,
  secondaryIds: string[],
): string {
  const segments = pathname.split("/");
  segments[segments.length - 1] = primaryId;
  const base = segments.join("/");
  const split = serializeSplitParam(secondaryIds);
  return split ? `${base}?split=${split}` : base;
}
