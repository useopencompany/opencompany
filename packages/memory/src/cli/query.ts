import type { GatewayUsageEntry } from "../retrieval/gateway";
import { query as runQuery } from "../retrieval/index";
import { loadProviders } from "../retrieval/providers";
import { isMemoryStatus, isMemoryType, type MemoryType } from "../schema";
import { type CommandContext, type CommandResult, fail, ok } from "./io";

// `--since` accepts a relative window (30m, 24h, 7d, 2w) or an absolute ISO-8601 timestamp.
// Relative windows resolve against the wall clock here so the agent never has to compute
// "now minus 24 hours" itself — LLM date math is a reliable source of off-by-a-day bugs.
const RELATIVE_SINCE = /^(\d+)([mhdw])$/;
const SINCE_UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export function resolveSince(raw: string, now: number = Date.now()): string | null {
  const trimmed = raw.trim();
  const relative = RELATIVE_SINCE.exec(trimmed);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = SINCE_UNIT_MS[relative[2] ?? ""];
    if (!unitMs || !Number.isFinite(amount) || amount <= 0) return null;
    return new Date(now - amount * unitMs).toISOString();
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

// Hybrid retrieval over the memory tree. Model-backed stages (expansion/vector/rerank) engage
// only when a Gateway key is present and `--lexical-only` is not set; otherwise it runs offline.
export async function query(ctx: CommandContext): Promise<CommandResult> {
  const { args, root } = ctx;
  const text = (args.get("text") ?? args.positionals.join(" ")).trim();

  const types = args.getAll("type").filter(isMemoryType) as MemoryType[];
  const statusInput = args.get("status");
  const lexicalOnly = args.has("lexical-only");

  // Collect the model-backed retrieval footprint so the runner can bill it. Always gathered when
  // the Gateway stages run; the CLI only emits it on stdout under --report-usage (see index.ts).
  const usage: GatewayUsageEntry[] = [];
  const providers = lexicalOnly
    ? {}
    : await loadProviders(process.env, (entry) => usage.push(entry));
  const folder = args.get("folder");
  const sinceInput = args.get("since");
  const since = sinceInput ? resolveSince(sinceInput) : undefined;
  if (sinceInput && !since) {
    return fail(
      `Invalid --since value "${sinceInput}". Use a relative window (30m, 24h, 7d, 2w) or an ISO-8601 timestamp.`,
    );
  }
  const hops = args.number("hops");

  const hits = await runQuery(
    root,
    {
      text,
      ...(types.length > 0 ? { types } : {}),
      ...(statusInput && isMemoryStatus(statusInput) ? { status: statusInput } : {}),
      ...(folder ? { folder } : {}),
      ...(since ? { since } : {}),
      ...(hops !== undefined && hops > 0 ? { hops } : {}),
      ...(args.has("include-merged") ? { includeMerged: true } : {}),
      ...(args.has("include-invalid") ? { includeInvalid: true } : {}),
      limit: args.number("limit") ?? 10,
      lexicalOnly,
    },
    providers,
  );

  const text_ =
    hits.length === 0
      ? "No matching memory found."
      : hits
          .map(
            (hit, i) =>
              `${i + 1}. [${hit.type}/${hit.status}] ${hit.id} (score ${hit.score}, updated ${hit.updatedAt})\n${hit.snippet}\nNext: memory get ${hit.id}`,
          )
          .join("\n\n");

  return { ...ok(text_, { count: hits.length, hits }), usage };
}
