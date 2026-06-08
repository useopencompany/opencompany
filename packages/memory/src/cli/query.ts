import type { GatewayUsageEntry } from "../retrieval/gateway";
import { query as runQuery } from "../retrieval/index";
import { loadProviders } from "../retrieval/providers";
import { isMemoryStatus, isMemoryType, type MemoryType } from "../schema";
import { type CommandContext, type CommandResult, ok } from "./io";

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
  const since = args.get("since");
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
            (hit, i) => `${i + 1}. [${hit.type}] ${hit.id} (score ${hit.score})\n   ${hit.snippet}`,
          )
          .join("\n");

  return { ...ok(text_, { count: hits.length, hits }), usage };
}
