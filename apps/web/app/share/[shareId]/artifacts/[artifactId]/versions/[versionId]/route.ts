import { getDb } from "@opencompany/db/client";
import {
  goatChatArtifacts,
  goatChatArtifactVersions,
  goatChatShares,
} from "@opencompany/db/goat-schema";
import { and, eq, isNull } from "drizzle-orm";
import { goatChatArtifactResponse } from "@/lib/chat-artifact-response";
import { isGoatChatShareId } from "@/lib/chat-sharing";

export async function GET(
  request: Request,
  {
    params,
  }: {
    params: Promise<{ shareId: string; artifactId: string; versionId: string }>;
  },
) {
  const { shareId, artifactId, versionId } = await params;
  if (!isGoatChatShareId(shareId)) return new Response(null, { status: 404 });
  const [row] = await getDb()
    .select({ version: goatChatArtifactVersions })
    .from(goatChatArtifactVersions)
    .innerJoin(goatChatArtifacts, eq(goatChatArtifactVersions.artifactId, goatChatArtifacts.id))
    .innerJoin(goatChatShares, eq(goatChatArtifacts.chatSessionId, goatChatShares.chatSessionId))
    .where(
      and(
        eq(goatChatShares.id, shareId),
        eq(goatChatArtifacts.id, artifactId),
        eq(goatChatArtifactVersions.id, versionId),
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
    shared: true,
  });
  return goatChatArtifactResponse(row.version, {
    download,
  });
}
