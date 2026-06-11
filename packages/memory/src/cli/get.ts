import { parseDocument } from "../document";
import { findFile } from "../store";
import { type CommandContext, type CommandResult, notFound, ok } from "./io";

const DEFAULT_TIMELINE_ENTRIES = 5;

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

  const section = args.get("section");
  // Section reads scope both the human `text` and machine `data` payload, so
  // `--section truth --json` returns only the truth. Without `--section`, the text is an
  // agent-friendly structured view while the JSON payload keeps the full parsed record.
  // Every shape keeps `id`/`path` (and `followedFrom`) so the caller always knows what it read.
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
    case "all":
      text = file.source;
      data = {
        ...base,
        frontmatter: parsed.frontmatter,
        title: parsed.title,
        compiledTruth: parsed.compiledTruth,
        timeline: parsed.timeline,
      };
      break;
    default: {
      const recentTimeline = parsed.timeline.slice(0, DEFAULT_TIMELINE_ENTRIES);
      const timelineText =
        recentTimeline.length === 0
          ? "_No timeline entries yet._"
          : recentTimeline.map((entry) => `### ${entry.at}\n${entry.body}`).join("\n\n");
      const aliases = parsed.frontmatter.aliases?.join(", ") || "none";
      const followedLine = followedFrom ? `Followed from: ${followedFrom}\n` : "";
      const moreTimeline =
        parsed.timeline.length > recentTimeline.length
          ? `\n\nShowing ${recentTimeline.length} of ${parsed.timeline.length} timeline entries. Run \`memory get ${base.id} --section timeline\` for the full timeline.`
          : "";
      text = [
        `# ${parsed.title || parsed.frontmatter.id || requestedId}`,
        "",
        `Path: ${file.relativePath}`,
        followedLine ? followedLine.trimEnd() : "",
        `Type: ${parsed.frontmatter.type ?? "unknown"}`,
        `Status: ${parsed.frontmatter.status ?? "unknown"}`,
        `Aliases: ${aliases}`,
        "",
        "## Compiled truth",
        parsed.compiledTruth.trim() || "_No compiled truth yet._",
        "",
        "## Recent timeline",
        timelineText,
        moreTimeline,
      ]
        .filter((part) => part !== "")
        .join("\n");
      data = {
        ...base,
        frontmatter: parsed.frontmatter,
        title: parsed.title,
        compiledTruth: parsed.compiledTruth,
        timeline: parsed.timeline,
        recentTimeline,
        timelineCount: parsed.timeline.length,
      };
    }
  }

  return ok(text, data);
}
