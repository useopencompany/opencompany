import { getDb } from "@opencompany/db/client";
import { goatChatArtifacts, goatChatArtifactVersions } from "@opencompany/db/goat-schema";
import { del } from "@vercel/blob";
import { and, eq, sql } from "drizzle-orm";
import { currentGoatUser } from "@/lib/auth";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ artifactId: string }> },
) {
  const context = await currentGoatUser({ optional: true });
  if (!context) return new Response(null, { status: 401 });
  const { artifactId } = await params;
  const db = getDb();
  const [artifact] = await db
    .select({
      id: goatChatArtifacts.id,
      chatSessionId: goatChatArtifacts.chatSessionId,
      archivedAt: goatChatArtifacts.archivedAt,
    })
    .from(goatChatArtifacts)
    .where(
      and(
        eq(goatChatArtifacts.id, artifactId),
        eq(goatChatArtifacts.userWorkosId, context.user.workosUserId),
      ),
    )
    .limit(1);
  if (!artifact) return new Response(null, { status: 404 });
  if (artifact.archivedAt) return Response.json({ ok: true, state: "deleted" });

  const now = new Date();
  await db
    .update(goatChatArtifacts)
    .set({ archivedAt: now, updatedAt: now })
    .where(
      and(
        eq(goatChatArtifacts.id, artifact.id),
        eq(goatChatArtifacts.userWorkosId, context.user.workosUserId),
      ),
    );
  // Read versions after the tombstone wins. A concurrent publication either committed before
  // this update and is included here, or observes archived_at and rolls its blob back.
  const versions = await db
    .select({ blobPathname: goatChatArtifactVersions.blobPathname })
    .from(goatChatArtifactVersions)
    .where(eq(goatChatArtifactVersions.artifactId, artifact.id));
  await db.execute(sql`
    UPDATE goat.chat_messages AS message
    SET debug_trace = jsonb_set(
          message.debug_trace,
          '{uiMessageParts}',
          COALESCE((
            SELECT jsonb_agg(
              CASE
                WHEN part.value->>'type' = 'data-artifact-file'
                  AND part.value#>>'{data,artifactId}' = ${artifact.id}
                THEN jsonb_set(part.value, '{data,state}', '"deleted"'::jsonb, true)
                ELSE part.value
              END
              ORDER BY part.ordinality
            )
            FROM jsonb_array_elements(
              COALESCE(message.debug_trace->'uiMessageParts', '[]'::jsonb)
            ) WITH ORDINALITY AS part(value, ordinality)
          ), '[]'::jsonb),
          true
        ),
        updated_at = ${now}
    WHERE message.session_id = ${artifact.chatSessionId}
      AND message.debug_trace IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          COALESCE(message.debug_trace->'uiMessageParts', '[]'::jsonb)
        ) AS candidate(value)
        WHERE candidate.value->>'type' = 'data-artifact-file'
          AND candidate.value#>>'{data,artifactId}' = ${artifact.id}
      )
  `);

  const blobPathnames = versions.map((version) => version.blobPathname);
  if (blobPathnames.length > 0) {
    await del(blobPathnames).catch((error) => {
      console.warn("Failed to remove archived chat artifact blobs.", {
        event: "goat.chat_artifact_blob_delete_failed",
        artifact_id: artifact.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  console.info("Generated chat file deleted.", {
    event: "goat.chat_artifact_deleted",
    artifact_id: artifact.id,
    version_count: versions.length,
  });
  return Response.json({ ok: true, state: "deleted" });
}
