// Slack channel names: lowercase, only a-z 0-9, hyphens/underscores, <= 80 chars.
// We build "<slug>-x-opencompany-<id-suffix>" — the customer name leads so the channel reads
// cleanly in Slack's sidebar, while the short per-workspace suffix at the END keeps two
// same-named customers from colliding. Fixed overhead "-x-opencompany" + "-" + 8-char
// suffix = 23 chars → slug cap 57.
const MAX_SLUG_LEN = 57;

export function workspaceChannelSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, ""); // re-trim: slice can cut mid-word and reintroduce a trailing hyphen
}

// "<slug>-x-opencompany-<suffix>" (or "<slug>-x-opencompany" when no suffix is given).
export function channelName(slug: string, suffix?: string): string {
  const base = `${slug || "team"}-x-opencompany`;
  return suffix ? `${base}-${suffix}` : base;
}
