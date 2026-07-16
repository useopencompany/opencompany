import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  GOAT_CODEX_CHAT_EVENT_TYPES,
  GOAT_LOCAL_CODEX_EVENT_TYPES,
  goatCodexChatEvents,
  goatLocalCodexEvents,
} from "./goat-schema";

const pgDialect = new PgDialect();

describe("Codex event constraints", () => {
  it("uses the canonical Local Codex event list in its database check", () => {
    expect(checkParams(goatLocalCodexEvents, "goat_local_codex_events_type_check")).toEqual(
      GOAT_LOCAL_CODEX_EVENT_TYPES,
    );
  });

  it("uses the canonical cloud Codex event list without delta-only event types", () => {
    expect(GOAT_CODEX_CHAT_EVENT_TYPES).toEqual(
      GOAT_LOCAL_CODEX_EVENT_TYPES.filter(
        (eventType) => eventType !== "assistant.delta" && eventType !== "command.output",
      ),
    );
    expect(checkParams(goatCodexChatEvents, "goat_codex_chat_events_type_check")).toEqual(
      GOAT_CODEX_CHAT_EVENT_TYPES,
    );
  });
});

function checkParams(
  table: typeof goatLocalCodexEvents | typeof goatCodexChatEvents,
  constraintName: string,
) {
  const constraint = getTableConfig(table).checks.find((check) => check.name === constraintName);
  expect(constraint, `Missing ${constraintName}`).toBeDefined();
  return pgDialect.sqlToQuery(constraint!.value).params;
}
