import {
  APPROVAL_RESOLUTIONS,
  RUN_APPROVAL_STATUSES,
  RUN_ATTEMPT_STATUSES,
  RUN_EVENT_TYPES,
} from "@opencompany/core";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  actionTurns,
  CODEX_CHAT_EVENT_TYPES,
  CODING_HARNESS_EVENT_TYPES,
  codexChatEvents,
  codexChatInteractions,
  runApprovals,
  runAttempts,
  runEvents,
} from "./product-schema";

const pgDialect = new PgDialect();

describe("Codex event constraints", () => {
  it("uses the canonical cloud Codex event list without delta-only event types", () => {
    expect(CODEX_CHAT_EVENT_TYPES).toEqual(
      CODING_HARNESS_EVENT_TYPES.filter(
        (eventType) => eventType !== "assistant.delta" && eventType !== "command.output",
      ),
    );
    expect(checkParams(codexChatEvents, "goat_codex_chat_events_type_check")).toEqual(
      CODEX_CHAT_EVENT_TYPES,
    );
  });
});

describe("ACP interaction constraints", () => {
  it("accepts ACP elicitation while preserving rolling-deploy compatibility", () => {
    const methodCheck = getTableConfig(codexChatInteractions).checks.find((constraint) =>
      pgDialect.sqlToQuery(constraint.value).sql.includes("elicitation/create"),
    );
    expect(methodCheck).toBeDefined();
    expect(pgDialect.sqlToQuery(methodCheck!.value).sql).toContain(
      `"method" IN ('elicitation/create', 'item/tool/requestUserInput')`,
    );
  });
});

describe("canonical Run constraints", () => {
  it("keeps attempt and semantic event values aligned with the application core", () => {
    expect(checkParams(runAttempts, "goat_run_attempts_status_check")).toEqual(
      RUN_ATTEMPT_STATUSES,
    );
    expect(checkParams(runEvents, "goat_run_events_type_check")).toEqual(RUN_EVENT_TYPES);
    expect(checkParams(runApprovals, "goat_run_approvals_status_check")).toEqual(
      RUN_APPROVAL_STATUSES,
    );
    expect(checkParams(runApprovals, "goat_run_approvals_resolution_check")).toEqual(
      APPROVAL_RESOLUTIONS,
    );
  });
});

describe("action gateway constraints", () => {
  it("uses the shared interactive and headless policies", () => {
    const policyCheck = getTableConfig(actionTurns).checks.find((constraint) =>
      pgDialect.sqlToQuery(constraint.value).sql.includes(`"policy" IN`),
    );
    expect(policyCheck).toBeDefined();
    expect(pgDialect.sqlToQuery(policyCheck!.value).sql).toContain(
      `"policy" IN ('foregroundInteractive', 'headless')`,
    );
  });
});

function checkParams(
  table:
    | typeof actionTurns
    | typeof codexChatEvents
    | typeof codexChatInteractions
    | typeof runAttempts
    | typeof runApprovals
    | typeof runEvents,
  constraintName: string,
) {
  return checkQuery(table, constraintName).params;
}

function checkQuery(
  table:
    | typeof actionTurns
    | typeof codexChatEvents
    | typeof codexChatInteractions
    | typeof runAttempts
    | typeof runApprovals
    | typeof runEvents,
  constraintName: string,
) {
  const constraint = getTableConfig(table).checks.find((check) => check.name === constraintName);
  expect(constraint, `Missing ${constraintName}`).toBeDefined();
  return pgDialect.sqlToQuery(constraint!.value);
}
