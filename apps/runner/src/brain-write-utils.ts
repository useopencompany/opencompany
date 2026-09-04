export function truncateByBytes(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let output = "";
  for (const char of value) {
    const next = `${output}${char}`;
    if (Buffer.byteLength(next, "utf8") > maxBytes) break;
    output = next;
  }
  return `${output}\n\n[Truncated to fit the opencompany Brain file size limit.]`;
}
