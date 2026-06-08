import { parseDocument } from "../document";
import { findFile } from "../store";
import { type CommandContext, type CommandResult, notFound, ok } from "./io";

// Fetch a memory file. `--section` narrows the output; `--follow` chases a merged record's
// redirect to its surviving target.
export async function get(ctx: CommandContext): Promise<CommandResult> {
  const { args, root } = ctx;
  const requestedId = args.positionals[0] ?? args.get("id");
  if (!requestedId) return notFound("Provide a memory id: `memory get <id>`.");

  let file = await findFile(root, requestedId);
  if (!file) return notFound(`No memory found with id "${requestedId}".`);

  let parsed = parseDocument(file.source);
  let followedFrom: string | null = null;
  if (
    args.has("follow") &&
    parsed.frontmatter.status === "merged" &&
    parsed.frontmatter.mergedInto
  ) {
    const target = await findFile(root, parsed.frontmatter.mergedInto);
    if (target) {
      followedFrom = requestedId;
      file = target;
      parsed = parseDocument(target.source);
    }
  }

  const section = args.get("section") ?? "all";
  // Both the human `text` and the machine `data` payload are scoped to the requested section, so
  // `--section truth --json` returns only the truth — not the whole record with the rest ignored.
  // Every section keeps `id`/`path` (and `followedFrom`) so the caller always knows what it read.
  const base = {
    id: parsed.frontmatter.id,
    path: file.relativePath,
    ...(followedFrom ? { followedFrom } : {}),
  };

  let text: string;
  let data: Record<string, unknown>;
  switch (section) {
    case "truth":
      text = parsed.compiledTruth;
      data = { ...base, title: parsed.title, compiledTruth: parsed.compiledTruth };
      break;
    case "timeline":
      text = parsed.timeline.map((entry) => `### ${entry.at}\n${entry.body}`).join("\n\n");
      data = { ...base, timeline: parsed.timeline };
      break;
    case "frontmatter":
      text = JSON.stringify(parsed.frontmatter, null, 2);
      data = { ...base, frontmatter: parsed.frontmatter };
      break;
    default:
      text = file.source;
      data = {
        ...base,
        frontmatter: parsed.frontmatter,
        title: parsed.title,
        compiledTruth: parsed.compiledTruth,
        timeline: parsed.timeline,
      };
  }

  return ok(text, data);
}
