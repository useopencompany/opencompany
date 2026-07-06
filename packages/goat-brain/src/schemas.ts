import {
  GOAT_BRAIN_ENTITY_TYPES,
  type GoatBrainEntityType,
  normalizeGoatBrainEntityType,
  normalizeGoatBrainFolder,
} from "./schema";

const ENTITY_TYPE_SET = new Set<string>(GOAT_BRAIN_ENTITY_TYPES);

export function isBuiltInGoatBrainEntityType(value: unknown): value is GoatBrainEntityType {
  return typeof value === "string" && ENTITY_TYPE_SET.has(value);
}

export function normalizeBuiltInGoatBrainEntityType(
  value: string | undefined,
): GoatBrainEntityType | null {
  if (!value) return null;
  const normalized = normalizeGoatBrainEntityType(value);
  if (normalized === "reference") return "source";
  if (normalized === "insight") return "note";
  return isBuiltInGoatBrainEntityType(normalized) ? normalized : null;
}

export function goatBrainFolderForEntityType(type: string | undefined): string {
  switch (normalizeBuiltInGoatBrainEntityType(type)) {
    case "person":
      return "people";
    case "company":
      return "companies";
    case "project":
      return "projects";
    case "meeting":
      return "meetings";
    case "decision":
      return "decisions";
    case "research":
      return "research";
    case "source":
      return "sources";
    case "note":
    default:
      return "inbox";
  }
}

export function inferGoatBrainEntityTypeFromFolder(folder: string): GoatBrainEntityType {
  const rootFolder = normalizeGoatBrainFolder(folder).split("/")[0] ?? "";
  if (rootFolder === "people") return "person";
  if (rootFolder === "companies") return "company";
  if (rootFolder === "projects") return "project";
  if (rootFolder === "meetings") return "meeting";
  if (rootFolder === "decisions") return "decision";
  if (rootFolder === "research") return "research";
  if (rootFolder === "references" || rootFolder === "docs" || rootFolder === "sources")
    return "source";
  return "note";
}
