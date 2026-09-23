export const WORKFLOW_NAME_MAX_LENGTH = 64;

export function workflowSlugFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+/u, "")
    .slice(0, WORKFLOW_NAME_MAX_LENGTH)
    .replace(/-+$/u, "");
  return slug || "workflow";
}
