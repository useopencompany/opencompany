import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStuckWorkReporter,
  listStuckRunnerWork,
  type StuckRunnerWork,
} from "./stuck-work-monitor";

const database = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock("./db", () => ({ getDb: () => database }));

const stuck = (id: string): StuckRunnerWork => ({
  kind: "codex_chat_turn",
  id,
  status: "running",
  updatedAt: new Date("2026-08-19T00:00:00.000Z"),
});

describe("stuck-work monitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.execute.mockResolvedValue({ rows: [] });
  });

  it("uses stable run-start and due timestamps instead of heartbeat-updated timestamps", async () => {
    await listStuckRunnerWork({
      now: new Date("2026-08-19T12:00:00.000Z"),
      turnThresholdMs: 60_000,
      backgroundThresholdMs: 120_000,
    });

    const query = new PgDialect().sqlToQuery(database.execute.mock.calls[0]?.[0] as SQL).sql;
    expect(query).toContain("COALESCE(attempt.started_at, turn.updated_at)");
    expect(query).toContain("job.next_run_at <=");
    expect(query).toContain("import_run.next_run_at <=");
    expect(query).toContain("task.status = 'waiting'");
    expect(query).not.toContain("job.updated_at <=");
  });

  it("reports each stuck period once and rearms after recovery", () => {
    const report = vi.fn();
    const observe = createStuckWorkReporter(report);

    observe([stuck("turn_1")]);
    observe([stuck("turn_1")]);
    observe([]);
    observe([stuck("turn_1")]);

    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenNthCalledWith(1, [stuck("turn_1")]);
  });
});
