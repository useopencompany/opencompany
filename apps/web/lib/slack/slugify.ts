// Slack channel names: lowercase, only a-z 0-9, hyphens/underscores, <= 80 chars.
// We reserve room for the "oc-" prefix + an optional "-<6 char>" collision suffix.
const MAX_SLUG_LEN = 72;

export function workspaceChannelSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_SLUG_LEN);
}

export function channelName(slug: string, suffix?: string): string {
  const safe = slug || "team";
  return suffix ? `oc-${safe}-${suffix}` : `oc-${safe}`;
}
