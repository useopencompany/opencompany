const REPLACEMENT_CHARACTER = "\uFFFD";
const POSTGRES_UNSAFE_JSON_ESCAPE = /\\u(?:0000|d[89a-f][0-9a-f]{2})/iu;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

// PostgreSQL jsonb rejects NUL and unpaired UTF-16 surrogates even though JSON.stringify emits
// syntactically valid JSON for them. Canonicalize through JSON first so toJSON, undefined, NaN,
// and array behavior stay identical to JSON.stringify, then normalize every persisted string/key.
export function stringifyPostgresJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("PostgreSQL JSON values must be JSON-serializable.");
  }
  if (!POSTGRES_UNSAFE_JSON_ESCAPE.test(serialized)) return serialized;

  return JSON.stringify(normalizeJsonValue(JSON.parse(serialized) as JsonValue));
}

function normalizeJsonValue(value: JsonValue): JsonValue {
  if (typeof value === "string") return normalizePostgresText(value);
  if (Array.isArray(value)) return value.map(normalizeJsonValue);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      normalizePostgresText(key),
      normalizeJsonValue(nestedValue),
    ]),
  );
}

export function normalizePostgresText(value: string): string {
  return value.toWellFormed().replaceAll("\0", REPLACEMENT_CHARACTER);
}
