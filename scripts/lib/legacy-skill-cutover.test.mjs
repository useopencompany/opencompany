import assert from "node:assert/strict";
import test from "node:test";

import { readLegacySkillCutoverState } from "./legacy-skill-cutover.mjs";

test("legacy Skill cutover reports table rows and deduplicated active Workflow Task hazards", async () => {
  const statements = [];
  const state = await readLegacySkillCutoverState(async (statement) => {
    statements.push(statement);
    if (statement.includes("to_regclass")) {
      return {
        rows: [
          { skills_table: "goat.skills", chat_session_skills_table: "goat.chat_session_skills" },
        ],
      };
    }
    if (statement.includes("FROM goat.skills")) return { rows: [{ count: "12" }] };
    if (statement.includes("FROM goat.chat_session_skills")) return { rows: [{ count: "7" }] };
    return {
      rows: [
        {
          legacy_skill_snapshot_tasks: "3",
          missing_skill_bundle_id_tasks: "4",
          legacy_dependent_tasks: "5",
        },
      ],
    };
  });

  assert.deepEqual(state, {
    skillsTablePresent: true,
    skillRows: 12,
    chatSessionSkillsTablePresent: true,
    chatSessionSkillRows: 7,
    legacySkillSnapshotTasks: 3,
    missingSkillBundleIdTasks: 4,
    legacyDependentTasks: 5,
  });
  const taskQuery = statements.find((statement) => statement.includes("active_workflow_tasks"));
  assert.ok(taskQuery);
  assert.match(taskQuery, /task\.status IN \('queued', 'running'\)/u);
  assert.match(taskQuery, /task\.workflow_id IS NOT NULL/u);
  assert.match(taskQuery, /jsonb_typeof\(task\.harness_spec->'workflow'\) = 'object'/u);
  assert.match(taskQuery, /\$\.\*\*\.skillSnapshots/u);
  assert.match(taskQuery, /jsonb_typeof\(step\.value->'skillBundleIds'\)/u);
  assert.match(taskQuery, /has_skill_snapshots OR missing_skill_bundle_ids/u);
});

test("legacy Skill cutover remains usable after the dropped tables are gone", async () => {
  const statements = [];
  const state = await readLegacySkillCutoverState(async (statement) => {
    statements.push(statement);
    if (statement.includes("to_regclass")) {
      return { rows: [{ skills_table: null, chat_session_skills_table: null }] };
    }
    return {
      rows: [
        {
          legacy_skill_snapshot_tasks: "0",
          missing_skill_bundle_id_tasks: "0",
          legacy_dependent_tasks: "0",
        },
      ],
    };
  });

  assert.deepEqual(state, {
    skillsTablePresent: false,
    skillRows: 0,
    chatSessionSkillsTablePresent: false,
    chatSessionSkillRows: 0,
    legacySkillSnapshotTasks: 0,
    missingSkillBundleIdTasks: 0,
    legacyDependentTasks: 0,
  });
  assert.equal(
    statements.some((statement) => statement.includes("FROM goat.skills")),
    false,
  );
  assert.equal(
    statements.some((statement) => statement.includes("FROM goat.chat_session_skills")),
    false,
  );
});
