import { createHash } from "node:crypto";
import type { Actor } from "@opencompany/core";
import type { MessagePresentation } from "@opencompany/protocol";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

export interface MessagePresentationService {
  get(input: {
    actor: Actor;
    conversationId: string;
    messageId: string;
  }): Promise<MessagePresentation | null>;
}

export class PostgresMessagePresentationService implements MessagePresentationService {
  constructor(private readonly execute: (query: SQL) => Promise<unknown>) {}

  async get(input: {
    actor: Actor;
    conversationId: string;
    messageId: string;
  }): Promise<MessagePresentation | null> {
    const rows = rowsFromExecute<{
      presentation: Record<string, unknown> | null;
      updatedAt: Date | string;
    }>(
      await this.execute(sql`
        SELECT message.presentation, message.updated_at AS "updatedAt"
        FROM goat.message_read_model_v1 AS message
        WHERE message.id = ${input.messageId}
          AND message.conversation_id = ${input.conversationId}
          AND (
            message.workspace_id = ${input.actor.workspaceId}
            OR (
              message.workspace_id IS NULL
              AND message.actor_id = ${input.actor.userId}
            )
          )
          AND EXISTS (
            SELECT 1
            FROM goat.workspace_members AS member
            WHERE member.workspace_id = ${input.actor.workspaceId}
              AND member.user_workos_id = ${input.actor.userId}
          )
        LIMIT 1
      `),
    );
    const row = rows[0];
    if (!row) return null;
    const updatedAt = row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt);
    if (Number.isNaN(updatedAt.getTime())) {
      throw new Error("The Message presentation has an invalid updated timestamp.");
    }
    return { presentation: row.presentation, updatedAt: updatedAt.toISOString() };
  }
}

export function messagePresentationEtag(messageId: string, updatedAt: string) {
  const digest = createHash("sha256").update(`${messageId}\0${updatedAt}`).digest("base64url");
  return `W/"${digest}"`;
}

function rowsFromExecute<Row>(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    return Array.isArray(rows) ? (rows as Row[]) : [];
  }
  return [];
}
