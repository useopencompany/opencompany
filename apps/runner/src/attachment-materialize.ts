import {
  ATTACHMENT_TEXT_INLINE_MAX_BYTES,
  attachmentSandboxFilename,
  shellQuote,
} from "@opencompany/agent-runtime";
import { agentSessionMessageAttachments } from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { and, eq, gt } from "drizzle-orm";
import { downloadBlobBytes } from "./attachment-hydration";
import { getDb } from "./db";
import { type SandboxHandle, sandboxLayout } from "./sandbox";

const logger = createLogger({ service: "opencompany-runner", runtime: "server" });

// Writes the session's above-threshold text attachments into the sandbox at
// work/attachments/<attachmentId>-<filename> so the model-message path reference
// (model-messages.ts largeTextAttachmentReference) always resolves. Runs on every sandbox
// acquire (ensureSandbox) so the files survive sandbox recycles; existing files are skipped
// (attachment rows are immutable) to keep repeat acquires cheap. Never throws — a failed
// materialization must not brick the session; the model still gets the inline preview.
export async function materializeLargeTextAttachmentsForSession(input: {
  sandbox: SandboxHandle;
  sessionId: string;
  workdir: string;
  blobToken: string | undefined;
}) {
  try {
    const db = getDb();
    const rows = await db
      .select({
        id: agentSessionMessageAttachments.id,
        blobPathname: agentSessionMessageAttachments.blobPathname,
        blobUrl: agentSessionMessageAttachments.blobUrl,
      })
      .from(agentSessionMessageAttachments)
      .where(
        and(
          eq(agentSessionMessageAttachments.sessionId, input.sessionId),
          eq(agentSessionMessageAttachments.kind, "text"),
          gt(agentSessionMessageAttachments.sizeBytes, ATTACHMENT_TEXT_INLINE_MAX_BYTES),
        ),
      );
    if (rows.length === 0) return;

    const layout = sandboxLayout(input.workdir);
    const dir = `${layout.workRoot}/attachments`;
    // The self-ignoring .gitignore keeps materialized attachments out of the agent's diffs,
    // commits, and PRs whatever repo ends up in work/.
    await input.sandbox.commands.run(
      `mkdir -p ${shellQuote(dir)} && printf '*\\n' > ${shellQuote(`${dir}/.gitignore`)}`,
    );
    const listing = await input.sandbox.commands.run(`ls -1 ${shellQuote(dir)}`);
    const existing = new Set(listing.stdout.split("\n").filter(Boolean));

    for (const row of rows) {
      const filename = attachmentSandboxFilename(row.blobPathname);
      if (existing.has(filename)) continue;
      try {
        const bytes = await downloadBlobBytes(row.blobUrl, input.blobToken);
        await input.sandbox.files.write(`${dir}/${filename}`, bytes.toString("utf8"));
      } catch (error) {
        captureException(error, {
          event: "opencompany.runner_attachment_materialize_failed",
          session_id: input.sessionId,
          attachment_id: row.id,
        });
        logger.warn("Failed to materialize attachment into sandbox", {
          session_id: input.sessionId,
          attachment_id: row.id,
        });
      }
    }
  } catch (error) {
    captureException(error, {
      event: "opencompany.runner_attachment_materialize_failed",
      session_id: input.sessionId,
    });
    logger.warn("Failed to materialize session attachments", { session_id: input.sessionId });
  }
}
