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
  const data = {
    id: parsed.frontmatter.id,
    path: file.relativePath,
    ...(followedFrom ? { followedFrom } : {}),
    frontmatter: parsed.frontmatter,
    title: parsed.title,
    compiledTruth: parsed.compiledTruth,
    timeline: parsed.timeline,
  };

  let text: string;
  switch (section) {
    case "truth":
      text = parsed.compiledTruth;
      break;
    case "timeline":
      text = parsed.timeline.map((entry) => `### ${entry.at}\n${entry.body}`).join("\n\n");
      break;
    case "frontmatter":
      text = JSON.stringify(parsed.frontmatter, null, 2);
      break;
    default:
      text = file.source;
  }

  return ok(text, data);
}
