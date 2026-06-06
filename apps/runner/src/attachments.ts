import { shellQuote } from "@opencompany/agent-runtime";
import { agentSessionMessages } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";
import { type SandboxHandle, sandboxLayout } from "./sandbox";

const PASTED_DIR = "pasted";

// Materialize every pasted-text attachment in a session into the sandbox working tree.
// Runs on every sandbox acquire (mirroring brain materialization) so the files survive a
// sandbox recycle — the model history references these paths and they must always exist.
// Writes are idempotent (filenames are deterministic: `pasted/<messageId>-<index>.txt`).
export async function materializePastedAttachmentsForSession(input: {
  sandbox: SandboxHandle;
  sessionId: string;
  workdir: string;
}) {
  const db = getDb();
  const rows = await db
    .select({ attachments: agentSessionMessages.attachments })
    .from(agentSessionMessages)
    .where(
      and(
        eq(agentSessionMessages.sessionId, input.sessionId),
        eq(agentSessionMessages.role, "user"),
      ),
    );

  const attachments = rows.flatMap((row) => row.attachments ?? []);
  if (attachments.length === 0) return;

  const layout = sandboxLayout(input.workdir);
  const pastedRoot = `${layout.workRoot}/${PASTED_DIR}`;
  await input.sandbox.commands.run(`mkdir -p ${shellQuote(pastedRoot)}`, { timeoutMs: 30_000 });

  for (const attachment of attachments) {
    // `filename` is server-assigned and starts with `pasted/`; resolve it under work/ and
    // refuse anything that would escape the pasted directory.
    const relative = safePastedRelativePath(attachment.filename);
    if (!relative) continue;
    await input.sandbox.files.write(`${layout.workRoot}/${relative}`, attachment.content);
  }

  await ensurePastedGitignore(input.sandbox, layout.workRoot);
}

// Keep paste artifacts out of the user's git working tree (diffs/PRs). Adds a `pasted/`
// entry to work/.gitignore, creating the file if absent and not duplicating the line.
async function ensurePastedGitignore(sandbox: SandboxHandle, workRoot: string) {
  const gitignore = `${workRoot}/.gitignore`;
  const entry = `${PASTED_DIR}/`;
  const script =
    `touch ${shellQuote(gitignore)} && ` +
    `grep -qxF ${shellQuote(entry)} ${shellQuote(gitignore)} || ` +
    `printf '%s\\n' ${shellQuote(entry)} >> ${shellQuote(gitignore)}`;
  await sandbox.commands.run(script, { timeoutMs: 30_000 });
}

function safePastedRelativePath(filename: string): string | null {
  const normalized = filename.trim().replace(/^\/+/, "");
  if (!normalized.startsWith(`${PASTED_DIR}/`)) return null;
  if (normalized.includes("\0") || normalized.includes("..")) return null;
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  return segments.join("/");
}
