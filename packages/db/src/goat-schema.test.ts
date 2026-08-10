import {
  APPROVAL_RESOLUTIONS,
  RUN_APPROVAL_STATUSES,
  RUN_ATTEMPT_STATUSES,
  RUN_EVENT_TYPES,
} from "@opencompany/core";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  GOAT_CODEX_APP_SERVER_EVENT_TYPES,
  GOAT_CODEX_CHAT_EVENT_TYPES,
  goatCodexChatEvents,
  goatRunApprovals,
  goatRunAttempts,
  goatRunEvents,
} from "./goat-schema";

const pgDialect = new PgDialect();

describe("Codex event constraints", () => {
  it("uses the canonical cloud Codex event list without delta-only event types", () => {
    expect(GOAT_CODEX_CHAT_EVENT_TYPES).toEqual(
      GOAT_CODEX_APP_SERVER_EVENT_TYPES.filter(
        (eventType) => eventType !== "assistant.delta" && eventType !== "command.output",
      ),
    );
    expect(checkParams(goatCodexChatEvents, "goat_codex_chat_events_type_check")).toEqual(
      GOAT_CODEX_CHAT_EVENT_TYPES,
    );
  });
});

describe("canonical Run constraints", () => {
  it("keeps attempt and semantic event values aligned with the application core", () => {
    expect(checkParams(goatRunAttempts, "goat_run_attempts_status_check")).toEqual(
      RUN_ATTEMPT_STATUSES,
    );
    expect(checkParams(goatRunEvents, "goat_run_events_type_check")).toEqual(RUN_EVENT_TYPES);
    expect(checkParams(goatRunApprovals, "goat_run_approvals_status_check")).toEqual(
      RUN_APPROVAL_STATUSES,
    );
    expect(checkParams(goatRunApprovals, "goat_run_approvals_resolution_check")).toEqual(
      APPROVAL_RESOLUTIONS,
    );
  });
});

function checkParams(
  table:
    | typeof goatCodexChatEvents
    | typeof goatRunAttempts
    | typeof goatRunApprovals
    | typeof goatRunEvents,
  constraintName: string,
) {
  const constraint = getTableConfig(table).checks.find((check) => check.name === constraintName);
  expect(constraint, `Missing ${constraintName}`).toBeDefined();
  return pgDialect.sqlToQuery(constraint!.value).params;
}
