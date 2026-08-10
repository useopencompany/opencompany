import { getDb } from "@opencompany/db/client";
import { goatChatArtifacts, goatChatArtifactVersions } from "@opencompany/db/goat-schema";
import { and, eq, isNull } from "drizzle-orm";
import { currentGoatUser } from "@/lib/auth";
import { goatChatArtifactResponse } from "@/lib/chat-artifact-response";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ artifactId: string; versionId: string }> },
) {
  const context = await currentGoatUser({ optional: true });
  if (!context) return new Response(null, { status: 401 });
  const { artifactId, versionId } = await params;
  const [row] = await getDb()
    .select({ version: goatChatArtifactVersions })
    .from(goatChatArtifactVersions)
    .innerJoin(goatChatArtifacts, eq(goatChatArtifactVersions.artifactId, goatChatArtifacts.id))
    .where(
      and(
        eq(goatChatArtifacts.id, artifactId),
        eq(goatChatArtifactVersions.id, versionId),
        eq(goatChatArtifacts.userWorkosId, context.user.workosUserId),
        isNull(goatChatArtifacts.archivedAt),
      ),
    )
    .limit(1);
  if (!row) return new Response(null, { status: 404 });
  const download = new URL(request.url).searchParams.get("download") === "1";
  console.info("Generated chat file opened.", {
    event: "goat.chat_artifact_opened",
    artifact_id: artifactId,
    artifact_version_id: versionId,
    disposition: download ? "download" : "preview",
    shared: false,
  });
  return goatChatArtifactResponse(row.version, {
    download,
  });
}
