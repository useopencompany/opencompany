import { Client } from "pg";

const ACTIVE_WORKFLOW_TASK_COUNTS_SQL = `
  WITH active_workflow_tasks AS (
    SELECT
      jsonb_path_exists(task.harness_spec, '$.**.skillSnapshots') AS has_skill_snapshots,
      jsonb_typeof(task.harness_spec->'workflow') = 'object' AS has_workflow_contract,
      CASE
        WHEN jsonb_typeof(task.harness_spec #> '{workflow,steps}') = 'array'
          THEN task.harness_spec #> '{workflow,steps}'
        ELSE '[]'::jsonb
      END AS steps
    FROM goat.tasks AS task
    WHERE task.status IN ('queued', 'running')
      AND task.workflow_id IS NOT NULL
  ), classified AS (
    SELECT
      has_skill_snapshots,
      has_workflow_contract
        AND (
          jsonb_array_length(steps) = 0
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(steps) AS step(value)
            WHERE jsonb_typeof(step.value->'skillBundleIds') IS DISTINCT FROM 'array'
          )
        ) AS missing_skill_bundle_ids
    FROM active_workflow_tasks
  )
  SELECT
    COUNT(*) FILTER (WHERE has_skill_snapshots)::bigint AS legacy_skill_snapshot_tasks,
    COUNT(*) FILTER (WHERE missing_skill_bundle_ids)::bigint AS missing_skill_bundle_id_tasks,
    COUNT(*) FILTER (
      WHERE has_skill_snapshots OR missing_skill_bundle_ids
    )::bigint AS legacy_dependent_tasks
  FROM classified
`;

export async function inspectLegacySkillCutover(databaseUrl) {
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    application_name: "opencompany-release-preflight",
  });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const state = await readLegacySkillCutoverState(client.query.bind(client));
    await client.query("COMMIT");
    return state;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

export async function readLegacySkillCutoverState(query) {
  const relations = await query(`
    SELECT
      to_regclass('goat.skills') AS skills_table,
      to_regclass('goat.chat_session_skills') AS chat_session_skills_table
  `);
  const relationState = relations.rows[0];
  if (!relationState) throw new Error("Could not inspect legacy Skill tables.");

  const skillsTablePresent = relationState.skills_table !== null;
  const chatSessionSkillsTablePresent = relationState.chat_session_skills_table !== null;
  const [skillRows, chatSessionSkillRows, taskCounts] = await Promise.all([
    skillsTablePresent ? countRows(query, "goat.skills") : Promise.resolve(0),
    chatSessionSkillsTablePresent
      ? countRows(query, "goat.chat_session_skills")
      : Promise.resolve(0),
    query(ACTIVE_WORKFLOW_TASK_COUNTS_SQL),
  ]);
  const taskRow = taskCounts.rows[0];
  if (!taskRow) throw new Error("Could not inspect queued and running Workflow Tasks.");

  return {
    skillsTablePresent,
    skillRows,
    chatSessionSkillsTablePresent,
    chatSessionSkillRows,
    legacySkillSnapshotTasks: countValue(
      taskRow.legacy_skill_snapshot_tasks,
      "legacy Skill snapshot Tasks",
    ),
    missingSkillBundleIdTasks: countValue(
      taskRow.missing_skill_bundle_id_tasks,
      "Tasks missing Skill bundle IDs",
    ),
    legacyDependentTasks: countValue(taskRow.legacy_dependent_tasks, "legacy-dependent Tasks"),
  };
}

async function countRows(query, relation) {
  if (relation !== "goat.skills" && relation !== "goat.chat_session_skills") {
    throw new Error("Unsupported legacy Skill relation.");
  }
  const result = await query(`SELECT COUNT(*)::bigint AS count FROM ${relation}`);
  return countValue(result.rows[0]?.count, `${relation} rows`);
}

function countValue(value, label) {
  const count = typeof value === "bigint" ? Number(value) : Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Invalid ${label} count returned by Postgres.`);
  }
  return count;
}
