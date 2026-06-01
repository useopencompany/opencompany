// Normalizes the result of `db.execute(sql\`...\`)` into a plain row array. The
// pooled `node-postgres` driver returns a `{ rows }` result object, while other
// drivers return the array directly; callers should not care which.
export function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}
