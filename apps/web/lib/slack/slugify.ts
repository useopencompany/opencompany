// Slack channel names: lowercase, only a-z 0-9, hyphens/underscores, <= 80 chars.
// We build "<slug>-x-opencompany" (matching the existing partner-channel convention,
// e.g. aurelio-x-opencompany). Fixed overhead "-x-opencompany" = 14 chars, so the slug
// must cap at 66.
const MAX_SLUG_LEN = 66;

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

// "<slug>-x-opencompany" — matches the existing partner-channel naming convention.
export function channelName(slug: string): string {
  return `${slug || "team"}-x-opencompany`;
}
