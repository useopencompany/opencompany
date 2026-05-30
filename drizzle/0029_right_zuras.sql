DO $$
DECLARE
  model_duplicate_groups integer;
  tool_duplicate_groups integer;
BEGIN
  SELECT COUNT(*) INTO model_duplicate_groups
  FROM (
    SELECT 1
    FROM agent_session_usage
    WHERE message_id IS NOT NULL
    GROUP BY session_id, message_id, step_index
    HAVING COUNT(*) > 1
  ) duplicates;

  SELECT COUNT(*) INTO tool_duplicate_groups
  FROM (
    SELECT 1
    FROM agent_session_tool_usage
    WHERE message_id IS NOT NULL
    GROUP BY session_id, message_id, tool_call_id, provider, operation
    HAVING COUNT(*) > 1
  ) duplicates;

  RAISE NOTICE 'agent_session_usage duplicate logical keys before H5/M9 migration: %', model_duplicate_groups;
  RAISE NOTICE 'agent_session_tool_usage duplicate logical keys before H5/M9 migration: %', tool_duplicate_groups;
END $$;--> statement-breakpoint
CREATE TEMP TABLE _h5_model_usage_rank AS
SELECT
  id,
  FIRST_VALUE(id) OVER usage_key AS canonical_id,
  ROW_NUMBER() OVER usage_key AS duplicate_rank
FROM agent_session_usage
WHERE message_id IS NOT NULL
WINDOW usage_key AS (
  PARTITION BY session_id, message_id, step_index
  ORDER BY id
);--> statement-breakpoint
CREATE TEMP TABLE _h5_tool_usage_rank AS
SELECT
  id,
  FIRST_VALUE(id) OVER usage_key AS canonical_id,
  ROW_NUMBER() OVER usage_key AS duplicate_rank
FROM agent_session_tool_usage
WHERE message_id IS NOT NULL
WINDOW usage_key AS (
  PARTITION BY session_id, message_id, tool_call_id, provider, operation
  ORDER BY id
);--> statement-breakpoint
WITH duplicate_model_ledgers AS (
  SELECT
    ledger.id,
    ledger.workspace_id,
    ledger.amount_usd_micros
  FROM workspace_credit_ledger ledger
  INNER JOIN _h5_model_usage_rank ranked ON ranked.id = ledger.model_usage_id
  WHERE ranked.duplicate_rank > 1
    AND NOT (
      NOT EXISTS (
        SELECT 1
        FROM workspace_credit_ledger canonical_ledger
        WHERE canonical_ledger.model_usage_id = ranked.canonical_id
      )
      AND ledger.id = (
        SELECT MIN(first_duplicate_ledger.id)
        FROM workspace_credit_ledger first_duplicate_ledger
        INNER JOIN _h5_model_usage_rank first_ranked
          ON first_ranked.id = first_duplicate_ledger.model_usage_id
        WHERE first_ranked.canonical_id = ranked.canonical_id
          AND first_ranked.duplicate_rank > 1
      )
    )
),
deleted_model_ledgers AS (
  DELETE FROM workspace_credit_ledger ledger
  USING duplicate_model_ledgers duplicate
  WHERE ledger.id = duplicate.id
  RETURNING duplicate.workspace_id, duplicate.amount_usd_micros
),
restored_model_balances AS (
  SELECT workspace_id, SUM(amount_usd_micros) AS amount_usd_micros
  FROM deleted_model_ledgers
  GROUP BY workspace_id
)
UPDATE workspace_credit_balances balance
SET balance_usd_micros = balance.balance_usd_micros - restored.amount_usd_micros,
    balance_cents = ROUND((balance.balance_usd_micros - restored.amount_usd_micros)::numeric / 10000)::integer,
    updated_at = now()
FROM restored_model_balances restored
WHERE balance.workspace_id = restored.workspace_id;--> statement-breakpoint
WITH model_ledgers_to_repoint AS (
  SELECT
    ledger.id AS ledger_id,
    ranked.canonical_id
  FROM workspace_credit_ledger ledger
  INNER JOIN _h5_model_usage_rank ranked ON ranked.id = ledger.model_usage_id
  WHERE ranked.duplicate_rank > 1
    AND NOT EXISTS (
      SELECT 1
      FROM workspace_credit_ledger canonical_ledger
      WHERE canonical_ledger.model_usage_id = ranked.canonical_id
    )
)
UPDATE workspace_credit_ledger ledger
SET model_usage_id = repoint.canonical_id
FROM model_ledgers_to_repoint repoint
WHERE ledger.id = repoint.ledger_id;--> statement-breakpoint
DELETE FROM agent_session_usage usage
USING _h5_model_usage_rank ranked
WHERE usage.id = ranked.id
  AND ranked.duplicate_rank > 1;--> statement-breakpoint
WITH duplicate_tool_ledgers AS (
  SELECT
    ledger.id,
    ledger.workspace_id,
    ledger.amount_usd_micros
  FROM workspace_credit_ledger ledger
  INNER JOIN _h5_tool_usage_rank ranked ON ranked.id = ledger.tool_usage_id
  WHERE ranked.duplicate_rank > 1
    AND NOT (
      NOT EXISTS (
        SELECT 1
        FROM workspace_credit_ledger canonical_ledger
        WHERE canonical_ledger.tool_usage_id = ranked.canonical_id
      )
      AND ledger.id = (
        SELECT MIN(first_duplicate_ledger.id)
        FROM workspace_credit_ledger first_duplicate_ledger
        INNER JOIN _h5_tool_usage_rank first_ranked
          ON first_ranked.id = first_duplicate_ledger.tool_usage_id
        WHERE first_ranked.canonical_id = ranked.canonical_id
          AND first_ranked.duplicate_rank > 1
      )
    )
),
deleted_tool_ledgers AS (
  DELETE FROM workspace_credit_ledger ledger
  USING duplicate_tool_ledgers duplicate
  WHERE ledger.id = duplicate.id
  RETURNING duplicate.workspace_id, duplicate.amount_usd_micros
),
restored_tool_balances AS (
  SELECT workspace_id, SUM(amount_usd_micros) AS amount_usd_micros
  FROM deleted_tool_ledgers
  GROUP BY workspace_id
)
UPDATE workspace_credit_balances balance
SET balance_usd_micros = balance.balance_usd_micros - restored.amount_usd_micros,
    balance_cents = ROUND((balance.balance_usd_micros - restored.amount_usd_micros)::numeric / 10000)::integer,
    updated_at = now()
FROM restored_tool_balances restored
WHERE balance.workspace_id = restored.workspace_id;--> statement-breakpoint
WITH tool_ledgers_to_repoint AS (
  SELECT
    ledger.id AS ledger_id,
    ranked.canonical_id
  FROM workspace_credit_ledger ledger
  INNER JOIN _h5_tool_usage_rank ranked ON ranked.id = ledger.tool_usage_id
  WHERE ranked.duplicate_rank > 1
    AND NOT EXISTS (
      SELECT 1
      FROM workspace_credit_ledger canonical_ledger
      WHERE canonical_ledger.tool_usage_id = ranked.canonical_id
    )
)
UPDATE workspace_credit_ledger ledger
SET tool_usage_id = repoint.canonical_id
FROM tool_ledgers_to_repoint repoint
WHERE ledger.id = repoint.ledger_id;--> statement-breakpoint
DELETE FROM agent_session_tool_usage usage
USING _h5_tool_usage_rank ranked
WHERE usage.id = ranked.id
  AND ranked.duplicate_rank > 1;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM agent_session_usage
    WHERE message_id IS NOT NULL
    GROUP BY session_id, message_id, step_index
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'agent_session_usage still has duplicate logical usage keys after H5 dedupe';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM agent_session_tool_usage
    WHERE message_id IS NOT NULL
    GROUP BY session_id, message_id, tool_call_id, provider, operation
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'agent_session_tool_usage still has duplicate logical usage keys after H5 dedupe';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" DROP CONSTRAINT "workspace_credit_ledger_model_usage_id_agent_session_usage_id_fk";--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" DROP CONSTRAINT "workspace_credit_ledger_tool_usage_id_agent_session_tool_usage_id_fk";--> statement-breakpoint
ALTER TABLE "agent_session_events" ALTER COLUMN "id" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "agent_session_events" ALTER COLUMN "id" SET DEFAULT nextval('agent_session_events_id_seq'::regclass);--> statement-breakpoint
ALTER TABLE "agent_session_tool_usage" ALTER COLUMN "id" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "agent_session_tool_usage" ALTER COLUMN "id" SET DEFAULT nextval('agent_session_tool_usage_id_seq'::regclass);--> statement-breakpoint
ALTER TABLE "agent_session_usage" ALTER COLUMN "id" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "agent_session_usage" ALTER COLUMN "id" SET DEFAULT nextval('agent_session_usage_id_seq'::regclass);--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" ALTER COLUMN "id" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" ALTER COLUMN "id" SET DEFAULT nextval('workspace_credit_ledger_id_seq'::regclass);--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" ALTER COLUMN "model_usage_id" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" ALTER COLUMN "tool_usage_id" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" ADD CONSTRAINT "workspace_credit_ledger_model_usage_id_agent_session_usage_id_fk" FOREIGN KEY ("model_usage_id") REFERENCES "public"."agent_session_usage"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_credit_ledger" ADD CONSTRAINT "workspace_credit_ledger_tool_usage_id_agent_session_tool_usage_id_fk" FOREIGN KEY ("tool_usage_id") REFERENCES "public"."agent_session_tool_usage"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_session_tool_usage_session_call_operation_idx" ON "agent_session_tool_usage" USING btree ("session_id","message_id","tool_call_id","provider","operation");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_session_usage_session_message_step_idx" ON "agent_session_usage" USING btree ("session_id","message_id","step_index");--> statement-breakpoint
DROP TABLE _h5_model_usage_rank;--> statement-breakpoint
DROP TABLE _h5_tool_usage_rank;
