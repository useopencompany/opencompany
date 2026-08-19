import {
  APPROVAL_RESOLUTIONS,
  RUN_APPROVAL_STATUSES,
  RUN_ATTEMPT_STATUSES,
  RUN_EVENT_TYPES,
} from "@opencompany/core";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  CODEX_CHAT_EVENT_TYPES,
  CODING_HARNESS_EVENT_TYPES,
  codexChatEvents,
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

function checkParams(
  table: typeof codexChatEvents | typeof runAttempts | typeof runApprovals | typeof runEvents,
  constraintName: string,
) {
  const constraint = getTableConfig(table).checks.find((check) => check.name === constraintName);
  expect(constraint, `Missing ${constraintName}`).toBeDefined();
  return pgDialect.sqlToQuery(constraint!.value).params;
}
