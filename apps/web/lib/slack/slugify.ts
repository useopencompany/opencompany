// Slack channel names: lowercase, only a-z 0-9, hyphens/underscores, <= 80 chars.
// The longest name we build is "oc-<slug>-<6-char suffix>" (collision retry), whose
// fixed overhead is "oc-" (3) + "-" (1) + 6 = 10 chars, so the slug must cap at 70.
const MAX_SLUG_LEN = 70;

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

export function channelName(slug: string, suffix?: string): string {
  const safe = slug || "team";
  return suffix ? `oc-${safe}-${suffix}` : `oc-${safe}`;
}
