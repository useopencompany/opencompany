const CONNECTOR_ORG_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function slugifyConnectorOrganizationName(name: string) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 63)
    .replace(/-+$/g, "");

  return slug || "team";
}

export function normalizeConnectorOrganizationSlug(slug: string) {
  return slugifyConnectorOrganizationName(slug);
}

export function validateConnectorOrganizationInput(input: { name: string; slug: string }) {
  const name = input.name.trim();
  const slug = normalizeConnectorOrganizationSlug(input.slug);

  if (name.length < 2) {
    return { ok: false as const, error: "Organization name must be at least 2 characters." };
  }
  if (name.length > 120) {
    return { ok: false as const, error: "Organization name must be 120 characters or less." };
  }
  if (slug.length < 2) {
    return { ok: false as const, error: "Slug must be at least 2 characters." };
  }
  if (!CONNECTOR_ORG_SLUG_PATTERN.test(slug)) {
    return {
      ok: false as const,
      error: "Slug can use lowercase letters, numbers, and single hyphens.",
    };
  }

  return { ok: true as const, name, slug };
}
