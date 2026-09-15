import { randomUUID } from "node:crypto";
import { createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import type { AcpSteeringMessage, AcpSteeringOutcome } from "./acp-harness";
import { getDb } from "./db";
import { rowsFromExecute } from "./sql-exec";

const logger = createLogger({ service: "opencompany-runner", runtime: "coding-chat-steering" });

// How often a running turn looks for a message the user promoted into it. Steering only matters
// while the user is watching the turn work, so this trades a little polling for a redirection that
// lands within about a second instead of at the next turn.
const STEERING_POLL_INTERVAL_MS = 1_000;

type PendingSteerRow = { id: string; prompt: string };

// A queued turn the user promoted into this running turn. It stays queued -- and therefore stays
// claimable as an ordinary next turn -- until an injection actually succeeds, so a turn that ends
// before the promotion is consumed simply runs the message instead of dropping it.
export async function loadPendingSteeringMessages(input: {
  runId: string;
  leaseId: string;
  leaseOwner: string;
}): Promise<AcpSteeringMessage[]> {
  const result = await getDb().execute(sql`
    SELECT source.id, source.prompt
    FROM goat.codex_chat_turns AS source
    JOIN goat.codex_chat_turns AS run ON run.id = source.steer_into_run_id
    WHERE source.steer_into_run_id = ${input.runId}
      AND source.status = 'queued'
      AND run.lease_id = ${input.leaseId}
      AND run.lease_owner = ${input.leaseOwner}
    ORDER BY source.created_at ASC, source.id ASC
  `);
  return rowsFromExecute<PendingSteerRow>(result).map((row) => ({
    id: row.id,
    prompt: [{ type: "text" as const, text: row.prompt }],
  }));
}

// Settles the promoted turn after the adapter confirms the injection. The running turn owns the
// session's only execution slot, so the promoted turn provably cannot have started in between and
// this is the single writer. Settling after the injection means a worker that dies in the gap
// leaves the message queued -- the user's words run a second time rather than vanishing.
export async function settleSteeredRun(input: {
  steeredRunId: string;
  runId: string;
  leaseId: string;
  leaseOwner: string;
  eventId: string;
}) {
  const now = new Date();
  await getDb().execute(sql`
    WITH steered AS (
      UPDATE goat.codex_chat_turns AS source
      SET status = 'interrupted',
          completed_at = ${now},
          event_sequence = source.event_sequence + 1,
          updated_at = ${now}
      FROM goat.codex_chat_turns AS run
      WHERE source.id = ${input.steeredRunId}
        AND source.status = 'queued'
        AND source.steer_into_run_id = ${input.runId}
        AND run.id = source.steer_into_run_id
        AND run.lease_id = ${input.leaseId}
        AND run.lease_owner = ${input.leaseOwner}
      RETURNING source.id, source.event_sequence
    )
    INSERT INTO goat.run_events (id, run_id, sequence, schema_version, type, payload, created_at)
    SELECT ${input.eventId}, steered.id, steered.event_sequence, 1, 'run.canceled',
           jsonb_build_object('by', 'steering'), ${now}
    FROM steered
  `);
}

// Yields every queued message the user steers into this run, oldest first, until the ACP harness
// closes the iterator at the end of the turn.
export function steeringMessageSource(input: {
  runId: string;
  leaseId: string;
  leaseOwner: string;
  pollIntervalMs?: number;
  load?: typeof loadPendingSteeringMessages;
}): AsyncIterable<AcpSteeringMessage> {
  const pollIntervalMs = input.pollIntervalMs ?? STEERING_POLL_INTERVAL_MS;
  const load = input.load ?? loadPendingSteeringMessages;
  return {
    async *[Symbol.asyncIterator]() {
      // A promotion the adapter refused is left queued on purpose, so it runs as the next turn.
      // Remember what has already been offered so the poll does not retry it every second.
      const offered = new Set<string>();
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        for (const message of await load(input)) {
          if (offered.has(message.id)) continue;
          offered.add(message.id);
          yield message;
        }
      }
    },
  };
}

// The steering half of an ACP turn: what to inject, and what to do once the adapter answers.
// Both coding engines wire it the same way, so the durable settlement and the transcript
// projection stay in one place.
export function createSteeringChannel(input: {
  engine: "codex" | "claude_code";
  runId: string;
  leaseId: string;
  leaseOwner: string;
  onRuntimeEvents: (events: Record<string, unknown>[]) => Promise<void>;
}) {
  return {
    steering: steeringMessageSource({
      runId: input.runId,
      leaseId: input.leaseId,
      leaseOwner: input.leaseOwner,
    }),
    onSteeringOutcome: async ({
      message,
      outcome,
    }: {
      message: AcpSteeringMessage;
      outcome: AcpSteeringOutcome;
    }) => {
      const logFields = {
        event: "opencompany.coding_chat_steering_outcome",
        engine: input.engine,
        run_id: input.runId,
        steered_run_id: message.id,
        outcome,
      };
      if (outcome !== "injected") {
        // The promoted turn is still queued, so the message runs as the next turn instead. Log it:
        // a refusal that is not a transient end-of-turn race is an adapter compatibility problem.
        logger.warn("Coding engine refused a steering message", logFields);
        return;
      }
      await settleSteeredRun({
        steeredRunId: message.id,
        runId: input.runId,
        leaseId: input.leaseId,
        leaseOwner: input.leaseOwner,
        eventId: `run_event_${randomUUID()}`,
      });
      await input.onRuntimeEvents([
        {
          method: "session/steering_delivered",
          params: {
            steeringMessageId: message.id,
            text: message.prompt
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join("\n"),
          },
        },
      ]);
      logger.info("Steered a running coding turn", logFields);
    },
  };
}

// The steering half of an opencompany-engine turn. The product agent keeps no long-lived adapter
// session to inject into: it rebuilds its message list for every model step, so a promoted message
// joins the turn at the next step boundary rather than mid-step. Everything else matches the ACP
// path -- the promoted turn stays queued until it is actually taken, so a turn that ends first
// simply runs the message next.
export function createProductSteeringChannel(input: {
  runId: string;
  leaseId: string;
  leaseOwner: string;
  onSteered: (message: { id: string; text: string }) => void;
  load?: typeof loadPendingSteeringMessages;
  settle?: typeof settleSteeredRun;
}) {
  const load = input.load ?? loadPendingSteeringMessages;
  const settle = input.settle ?? settleSteeredRun;
  // A promotion is settled the moment it is taken, so a poll that overlaps the previous step's
  // injection cannot hand the same message to the model twice.
  const taken = new Set<string>();
  return {
    // Steering rides alongside a turn that is already producing work, so nothing on this leg may
    // fail it: a poll or settlement that throws leaves the promotion queued, which is what the
    // design already promises -- the message runs as the next turn instead of being lost.
    async take(): Promise<string[]> {
      const texts: string[] = [];
      try {
        for (const message of await load(input)) {
          if (taken.has(message.id)) continue;
          const text = message.prompt
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n");
          if (!text.trim()) continue;
          taken.add(message.id);
          await settle({
            steeredRunId: message.id,
            runId: input.runId,
            leaseId: input.leaseId,
            leaseOwner: input.leaseOwner,
            eventId: `run_event_${randomUUID()}`,
          });
          input.onSteered({ id: message.id, text });
          texts.push(text);
          logger.info("Steered a running opencompany turn", {
            event: "opencompany.coding_chat_steering_outcome",
            engine: "opencompany",
            run_id: input.runId,
            steered_run_id: message.id,
            outcome: "injected",
          });
        }
      } catch (error) {
        logger.warn("Steering an opencompany turn failed; leaving the message queued", {
          event: "opencompany.coding_chat_steering_outcome",
          engine: "opencompany",
          run_id: input.runId,
          outcome: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return texts;
    },
  };
}
