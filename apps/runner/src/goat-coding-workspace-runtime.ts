import { type CloudCodingEngine, isCloudCodingEngine } from "@opencompany/agent-runtime";
import {
  type GoatCodexChatSessionStatus,
  goatChatSessions,
  goatCodexChatSessions,
} from "@opencompany/db/goat-schema";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { createGoatCodingWorkspaceTicket } from "./goat-coding-workspace-runtime-auth";
import { getSandboxLifecycleStatus, type SandboxHandle } from "./sandbox";

const RESERVED_PREVIEW_PORTS = new Set([22, 4_998, 4_999, 49_983, 50_005]);
const MAX_DISCOVERED_PORTS = 24;

export const GOAT_CODING_WORKSPACE_SANDBOX_NETWORK = {
  allowPublicTraffic: false,
  maskRequestHost: "localhost:${PORT}",
} as const;

export type GoatCodingWorkspaceSession = {
  id: string;
  chatSessionId: string;
  userWorkosId: string;
  sandboxId: string;
  status: GoatCodexChatSessionStatus;
  engine: CloudCodingEngine;
};

type StoredCodingWorkspaceSession = Omit<GoatCodingWorkspaceSession, "engine" | "sandboxId"> & {
  engine: unknown;
  sandboxId: string | null;
};

export class GoatCodingWorkspaceAccessError extends Error {
  constructor(
    message: string,
    readonly statusCode: 404 | 409 | 503,
  ) {
    super(message);
    this.name = "GoatCodingWorkspaceAccessError";
  }
}

export async function loadGoatCodingWorkspaceSession(input: {
  codingSessionId: string;
  userWorkosId?: string;
}): Promise<GoatCodingWorkspaceSession | null> {
  const row = await loadStoredCodingWorkspaceSession(input);
  if (!row || !row.sandboxId || row.status === "closed" || !isCloudCodingEngine(row.engine)) {
    return null;
  }
  return { ...row, sandboxId: row.sandboxId, engine: row.engine };
}

async function loadStoredCodingWorkspaceSession(input: {
  codingSessionId: string;
  userWorkosId?: string;
}): Promise<StoredCodingWorkspaceSession | null> {
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
      engine: goatCodexChatSessions.engine,
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
      and(eq(goatCodexChatSessions.id, input.codingSessionId), ...(ownership ? [ownership] : [])),
    )
    .limit(1);

  return row ?? null;
}

export async function mintGoatCodingWorkspaceAccess(input: {
  codingSessionId: string;
  userWorkosId: string;
  env: Pick<RunnerEnv, "streamTokenSecret">;
}) {
  const session = await loadStoredCodingWorkspaceSession(input);
  if (!session || session.status === "closed" || !isCloudCodingEngine(session.engine)) {
    throw new GoatCodingWorkspaceAccessError(
      "This coding workspace is not available or no longer exists.",
      404,
    );
  }
  if (!session.sandboxId) {
    throw new GoatCodingWorkspaceAccessError(
      "This coding workspace is not ready yet. Send a message first.",
      409,
    );
  }

  const sandboxStatus = await getSandboxLifecycleStatus(session.sandboxId);
  if (sandboxStatus === "deleted") {
    throw new GoatCodingWorkspaceAccessError(
      "This coding workspace has been deleted. Send another message to create a new workspace.",
      409,
    );
  }

  const signed = createGoatCodingWorkspaceTicket({
    codingSessionId: session.id,
    userWorkosId: session.userWorkosId,
    secret: input.env.streamTokenSecret,
  });
  return { ...signed, sandboxStatus };
}

export type GoatCodingWorkspacePreviewPort = {
  port: number;
  isHttp: boolean;
  score: number;
};

export async function discoverGoatCodingWorkspacePreviewPorts(
  sandbox: SandboxHandle,
): Promise<GoatCodingWorkspacePreviewPort[]> {
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
