import { listGoatBrainFiles } from "@opencompany/db/goat-brain-files";
import { isValidGoatBrainId } from "@opencompany/goat-brain/schema";

export async function nextAvailableGoatBrainId(brainRef: string, baseId: string): Promise<string> {
  const base = isValidGoatBrainId(baseId) ? baseId : "untitled";
  const rows = await listGoatBrainFiles({ brainRef }, { includeInvalid: true });
  const used = new Set(rows.map((row) => row.brainId));
  if (!used.has(base)) return base;

  for (let suffix = 2; suffix < 1000; suffix++) {
    const ending = `-${suffix}`;
    const prefix = base.slice(0, 80 - ending.length).replace(/-+$/g, "");
    const candidate = `${prefix || "untitled"}${ending}`;
    if (!used.has(candidate)) return candidate;
  }

  throw new Error("Could not allocate a unique brain id.");
}
