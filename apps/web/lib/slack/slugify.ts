// Slack channel names: lowercase, only a-z 0-9, hyphens/underscores, <= 80 chars.
// We build "<slug>-<id-suffix>-x-opencompany" — the -x-opencompany convention plus a short
// per-workspace suffix that keeps the name globally unique (a same-named customer never
// collides). Fixed overhead "-" + 6-char suffix + "-x-opencompany" = 21 chars → slug cap 59.
const MAX_SLUG_LEN = 59;

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

// "<slug>-<suffix>-x-opencompany" (or "<slug>-x-opencompany" when no suffix is given).
export function channelName(slug: string, suffix?: string): string {
  const safe = slug || "team";
  return suffix ? `${safe}-${suffix}-x-opencompany` : `${safe}-x-opencompany`;
}
