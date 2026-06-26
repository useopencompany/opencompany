import { attachmentSandboxFilename, shellQuote } from "@opencompany/agent-runtime";
import { agentSessionMessageAttachments } from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { and, eq } from "drizzle-orm";
import { downloadBlobBytes } from "./attachment-hydration";
import { getDb } from "./db";
import { type SandboxHandle, sandboxLayout, writeSandboxTextFiles } from "./sandbox";

const logger = createLogger({ service: "opencompany-runner", runtime: "server" });

export type CodexAttachment = {
  filename: string;
  kind: string;
  mediaType: string;
  path: string;
};

export async function materializeCodexAttachmentsForSession(input: {
  sandbox: SandboxHandle;
  sessionId: string;
  messageId?: string | undefined;
  workdir: string;
  blobToken: string | undefined;
}): Promise<CodexAttachment[]> {
  const rows = await getDb()
    .select({
      id: agentSessionMessageAttachments.id,
      blobPathname: agentSessionMessageAttachments.blobPathname,
      blobUrl: agentSessionMessageAttachments.blobUrl,
      filename: agentSessionMessageAttachments.filename,
      kind: agentSessionMessageAttachments.kind,
      mediaType: agentSessionMessageAttachments.mediaType,
    })
    .from(agentSessionMessageAttachments)
    .where(
      input.messageId
        ? and(
            eq(agentSessionMessageAttachments.sessionId, input.sessionId),
            eq(agentSessionMessageAttachments.messageId, input.messageId),
          )
        : eq(agentSessionMessageAttachments.sessionId, input.sessionId),
    );
  if (rows.length === 0) return [];

  const layout = sandboxLayout(input.workdir);
  const dir = `${layout.codexRoot}/work/attachments`;
  await input.sandbox.commands.run(
    `mkdir -p ${shellQuote(dir)} && printf '*\\n' > ${shellQuote(`${dir}/.gitignore`)}`,
    { timeoutMs: 30_000 },
  );
  const listing = await input.sandbox.commands.run(`ls -1 ${shellQuote(dir)}`, {
    timeoutMs: 30_000,
  });
  const existing = new Set(listing.stdout.split("\n").filter(Boolean));

  const materialized: CodexAttachment[] = [];
  for (const row of rows) {
    const sandboxFilename = attachmentSandboxFilename(row.blobPathname);
    const absolutePath = `${dir}/${sandboxFilename}`;
    const relativePath = `work/attachments/${sandboxFilename}`;

    if (!existing.has(sandboxFilename)) {
      try {
        const bytes = await downloadBlobBytes(row.blobUrl, input.blobToken);
        await writeSandboxTextFiles({
          sandbox: input.sandbox,
          files: [{ path: absolutePath, content: bytes }],
        });
      } catch (error) {
        captureException(error, {
          event: "opencompany.runner_codex_attachment_materialize_failed",
          session_id: input.sessionId,
          attachment_id: row.id,
        });
        logger.warn("Failed to materialize Codex attachment into sandbox", {
          session_id: input.sessionId,
          attachment_id: row.id,
        });
        throw error;
      }
      existing.add(sandboxFilename);
    }

    materialized.push({
      filename: row.filename,
      kind: row.kind,
      mediaType: row.mediaType,
      path: relativePath,
    });
  }

  return materialized;
}
