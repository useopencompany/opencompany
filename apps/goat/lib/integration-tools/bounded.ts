// Bounded provider results: integration tools must never stream an unbounded
// provider payload into the model context. Values are shrunk structurally
// first (string/array/depth caps), then hard-capped on serialized size.

const MAX_STRING_LENGTH = 4000;
const MAX_ARRAY_ITEMS = 50;
const MAX_DEPTH = 8;
const MAX_SERIALIZED_CHARS = 30_000;

export function boundIntegrationToolResult(value: unknown): {
  result: unknown;
  truncated: boolean;
} {
  const { value: shrunk, truncated } = shrinkValue(value, 0);
  const serialized = safeStringify(shrunk);
  if (serialized !== null && serialized.length > MAX_SERIALIZED_CHARS) {
    return {
      result: {
        truncated: true,
        preview: serialized.slice(0, MAX_SERIALIZED_CHARS),
      },
      truncated: true,
    };
  }
  return { result: shrunk, truncated };
}

function shrinkValue(value: unknown, depth: number): { value: unknown; truncated: boolean } {
  if (typeof value === "string") {
    if (value.length <= MAX_STRING_LENGTH) return { value, truncated: false };
    return { value: `${value.slice(0, MAX_STRING_LENGTH)}… [truncated]`, truncated: true };
  }
  if (value === null || typeof value !== "object") return { value, truncated: false };
  if (depth >= MAX_DEPTH) return { value: "[max depth]", truncated: true };

  if (Array.isArray(value)) {
    let truncated = value.length > MAX_ARRAY_ITEMS;
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => {
      const shrunk = shrinkValue(item, depth + 1);
      truncated = truncated || shrunk.truncated;
      return shrunk.value;
    });
    return { value: items, truncated };
  }

  let truncated = false;
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const shrunk = shrinkValue(entry, depth + 1);
    truncated = truncated || shrunk.truncated;
    record[key] = shrunk.value;
  }
  return { value: record, truncated };
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}
