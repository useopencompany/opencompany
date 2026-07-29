import {
  type GoatCodexChatSessionStatus,
  goatChatSessions,
  goatCodexChatSessions,
} from "@opencompany/db/goat-schema";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { createGoatCodexRuntimeTicket } from "./goat-codex-runtime-auth";
import { getSandboxLifecycleStatus, type SandboxHandle } from "./sandbox";

const RESERVED_PREVIEW_PORTS = new Set([22, 4_998, 4_999, 49_983, 50_005]);
const MAX_DISCOVERED_PORTS = 24;

export type GoatCodexRuntimeSession = {
  id: string;
  chatSessionId: string;
  userWorkosId: string;
  sandboxId: string;
  status: GoatCodexChatSessionStatus;
};

export class GoatCodexRuntimeAccessError extends Error {
  constructor(
    message: string,
    readonly statusCode: 404 | 409 | 503,
  ) {
    super(message);
    this.name = "GoatCodexRuntimeAccessError";
  }
}

export async function loadGoatCodexRuntimeSession(input: {
  codexChatSessionId: string;
  userWorkosId?: string;
}): Promise<GoatCodexRuntimeSession | null> {
  const ownership = input.userWorkosId
    ? eq(goatCodexChatSessions.userWorkosId, input.userWorkosId)
    : undefined;
  const [row] = await getDb()
    .select({
      id: goatCodexChatSessions.id,
      chatSessionId: goatCodexChatSessions.chatSessionId,
      userWorkosId: goatCodexChatSessions.userWorkosId,
      sandboxId: goatCodexChatSessions.sandboxId,
      status: goatCodexChatSessions.status,
    })
    .from(goatCodexChatSessions)
    .innerJoin(
      goatChatSessions,
      and(
        eq(goatChatSessions.id, goatCodexChatSessions.chatSessionId),
        isNull(goatChatSessions.closedAt),
      ),
    )
    .where(
      and(
        eq(goatCodexChatSessions.id, input.codexChatSessionId),
        ...(ownership ? [ownership] : []),
      ),
    )
    .limit(1);

  if (!row?.sandboxId || row.status === "closed") return null;
  return { ...row, sandboxId: row.sandboxId };
}

export async function mintGoatCodexRuntimeAccess(input: {
  codexChatSessionId: string;
  userWorkosId: string;
  env: Pick<RunnerEnv, "streamTokenSecret">;
}) {
  const session = await loadGoatCodexRuntimeSession(input);
  if (!session) {
    throw new GoatCodexRuntimeAccessError(
      "This Codex workspace is not available yet or no longer exists.",
      404,
    );
  }

  const sandboxStatus = await getSandboxLifecycleStatus(session.sandboxId);
  if (sandboxStatus === "deleted") {
    throw new GoatCodexRuntimeAccessError(
      "This Codex workspace has been deleted. Send another message to create a new workspace.",
      409,
    );
  }

  const signed = createGoatCodexRuntimeTicket({
    codexChatSessionId: session.id,
    userWorkosId: session.userWorkosId,
    secret: input.env.streamTokenSecret,
  });
  return { ...signed, sandboxStatus };
}

export type GoatCodexPreviewPort = {
  port: number;
  isHttp: boolean;
  score: number;
};

export async function discoverGoatCodexPreviewPorts(
  sandbox: SandboxHandle,
): Promise<GoatCodexPreviewPort[]> {
  const result = await sandbox.commands.run(
    "ss -H -ltn 2>/dev/null | awk '{print $4}' | sed 's/.*://' | sort -nu",
    { user: "user", timeoutMs: 10_000 },
  );
  const ports = parseListeningPorts(result.stdout);
  const probed = await Promise.all(
    ports.map(async (port) => {
      const probe = await sandbox.commands
        .run(
          `curl --silent --show-error --output /dev/null --max-time 2 --write-out '%{http_code}' http://127.0.0.1:${port}/`,
          { user: "user", timeoutMs: 5_000 },
        )
        .catch(() => null);
      const status = Number(probe?.stdout.trim());
      return {
        port,
        isHttp: Number.isInteger(status) && status >= 100 && status <= 599,
        score: previewPortScore(port, Number.isInteger(status) && status >= 100 && status <= 599),
      };
    }),
  );

  return probed.sort((a, b) => b.score - a.score || a.port - b.port);
}

export function parseListeningPorts(output: string) {
  return [...new Set(output.split(/\s+/).map(Number))]
    .filter(isAllowedPreviewPort)
    .slice(0, MAX_DISCOVERED_PORTS);
}

export function isAllowedPreviewPort(port: number) {
  return (
    Number.isInteger(port) && port >= 1_024 && port <= 65_535 && !RESERVED_PREVIEW_PORTS.has(port)
  );
}

function previewPortScore(port: number, isHttp: boolean) {
  const commonRank = [3_000, 5_173, 4_173, 8_000, 8_080, 4_200, 5_000].indexOf(port);
  return (isHttp ? 1_000 : 0) + (commonRank === -1 ? 0 : 100 - commonRank);
}
