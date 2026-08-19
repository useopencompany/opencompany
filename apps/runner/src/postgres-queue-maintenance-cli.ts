import "./load-env";
import { registerNodeObservability, shutdownNodeObservability } from "@opencompany/telemetry/node";
import { assertRunnerDbConfig, closeDb, getDbPool } from "./db";
import {
  EXECUTION_EVENT_RETENTION_DAYS,
  reportPostgresQueueMaintenance,
  runPostgresQueueMaintenance,
  TERMINAL_TURN_RETENTION_DAYS,
} from "./postgres-queue-maintenance";

const EXECUTE_FLAG = "--execute";

if (!process.argv.includes(EXECUTE_FLAG)) {
  console.error(
    [
      "Postgres queue maintenance did not run.",
      `Policy: terminal event logs ${EXECUTION_EVENT_RETENTION_DAYS} days; terminal turns ${TERMINAL_TURN_RETENTION_DAYS} days.`,
      `After the retention policy is approved, rerun with ${EXECUTE_FLAG}.`,
    ].join("\n"),
  );
  process.exitCode = 2;
} else {
  registerNodeObservability({ serviceName: "opencompany-postgres-queue-maintenance" });
  try {
    assertRunnerDbConfig();
    const result = await runPostgresQueueMaintenance({ pool: getDbPool() });
    if (!result.acquired) {
      console.info("Postgres queue maintenance skipped: another invocation holds the lock.");
    } else {
      reportPostgresQueueMaintenance(result);
      console.info("Postgres queue maintenance completed.");
    }
  } finally {
    await closeDb();
    await shutdownNodeObservability();
  }
}
