import type { KpiCatalogEntry } from "@/lib/kpis/types";

type KpiConfigResult = { ok: true; config: Record<string, unknown> } | { ok: false; error: string };

export function normalizeKpiMetricConfig(entry: KpiCatalogEntry, input: unknown): KpiConfigResult {
  const fields = entry.configFields ?? [];
  if (fields.length === 0) {
    if (input && isPlainObject(input) && Object.keys(input).length > 0) {
      return { ok: false, error: "This KPI metric does not accept custom configuration." };
    }
    return { ok: true, config: {} };
  }

  if (input !== undefined && input !== null && !isPlainObject(input)) {
    return { ok: false, error: "KPI metric configuration is invalid." };
  }

  const raw = (input ?? {}) as Record<string, unknown>;
  const allowedKeys = new Set(fields.map((field) => field.key));
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) return { ok: false, error: `Unknown KPI option "${key}".` };
  }

  const config: Record<string, unknown> = {};
  for (const field of fields) {
    const value = raw[field.key] ?? field.defaultValue ?? "";
    if (typeof value !== "string") {
      return { ok: false, error: `${field.label} must be text.` };
    }

    const trimmed = value.trim();
    if (field.required && !trimmed) {
      return { ok: false, error: `${field.label} is required.` };
    }

    const maxLength = field.maxLength ?? 240;
    if (trimmed.length > maxLength) {
      return { ok: false, error: `${field.label} must be ${maxLength} characters or fewer.` };
    }

    if (trimmed) config[field.key] = trimmed;
  }

  return { ok: true, config };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
