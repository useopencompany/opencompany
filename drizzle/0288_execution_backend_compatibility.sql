-- Persist execution ownership before introducing the sandbox-supervisor worker. Existing and new
-- rows remain on the established runner; v2 admission is deliberately absent from this migration.
ALTER TABLE "goat"."codex_chat_sessions"
	ADD COLUMN "execution_backend" text DEFAULT 'runner_attached' NOT NULL,
	ADD COLUMN "execution_backend_version" integer DEFAULT 1 NOT NULL,
	ADD COLUMN "supervisor_template_version" text;
--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_sessions"
	ADD CONSTRAINT "goat_codex_chat_sessions_execution_backend_check"
	CHECK ("codex_chat_sessions"."execution_backend" IN ('runner_attached', 'sandbox_supervisor')),
	ADD CONSTRAINT "goat_codex_chat_sessions_execution_backend_version_check"
	CHECK ("codex_chat_sessions"."execution_backend_version" > 0),
	ADD CONSTRAINT "goat_codex_chat_sessions_supervisor_template_version_check"
	CHECK (
		("codex_chat_sessions"."execution_backend" = 'runner_attached' AND "codex_chat_sessions"."supervisor_template_version" IS NULL)
		OR
		("codex_chat_sessions"."execution_backend" = 'sandbox_supervisor' AND NULLIF("codex_chat_sessions"."supervisor_template_version", '') IS NOT NULL)
	);
--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_turns"
	ADD COLUMN "execution_backend" text DEFAULT 'runner_attached' NOT NULL,
	ADD COLUMN "execution_backend_version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_turns"
	ADD CONSTRAINT "goat_codex_chat_turns_execution_backend_check"
	CHECK ("codex_chat_turns"."execution_backend" IN ('runner_attached', 'sandbox_supervisor')),
	ADD CONSTRAINT "goat_codex_chat_turns_execution_backend_version_check"
	CHECK ("codex_chat_turns"."execution_backend_version" > 0);
--> statement-breakpoint
CREATE INDEX "goat_codex_chat_turns_execution_claim_idx"
	ON "goat"."codex_chat_turns" USING btree (
		"execution_backend", "execution_backend_version", "status", "created_at"
	);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION goat.reject_execution_binding_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'execution binding is immutable for %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME
		USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "goat_codex_chat_sessions_execution_binding_immutable"
	BEFORE UPDATE OF "execution_backend", "execution_backend_version", "supervisor_template_version"
	ON "goat"."codex_chat_sessions"
	FOR EACH ROW
	WHEN (
		OLD."execution_backend" IS DISTINCT FROM NEW."execution_backend"
		OR OLD."execution_backend_version" IS DISTINCT FROM NEW."execution_backend_version"
		OR OLD."supervisor_template_version" IS DISTINCT FROM NEW."supervisor_template_version"
	)
	EXECUTE FUNCTION goat.reject_execution_binding_update();
--> statement-breakpoint
CREATE TRIGGER "goat_codex_chat_turns_execution_binding_immutable"
	BEFORE UPDATE OF "execution_backend", "execution_backend_version"
	ON "goat"."codex_chat_turns"
	FOR EACH ROW
	WHEN (
		OLD."execution_backend" IS DISTINCT FROM NEW."execution_backend"
		OR OLD."execution_backend_version" IS DISTINCT FROM NEW."execution_backend_version"
	)
	EXECUTE FUNCTION goat.reject_execution_binding_update();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION goat.enforce_codex_chat_turn_execution_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM goat.codex_chat_sessions AS session
		WHERE session.id = NEW.codex_chat_session_id
			AND session.execution_backend = NEW.execution_backend
			AND session.execution_backend_version = NEW.execution_backend_version
	) THEN
		RAISE EXCEPTION 'Run execution binding must match Session %', NEW.codex_chat_session_id
			USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "goat_codex_chat_turns_execution_binding_matches_session"
	BEFORE INSERT OR UPDATE OF "codex_chat_session_id", "execution_backend", "execution_backend_version"
	ON "goat"."codex_chat_turns"
	FOR EACH ROW
	EXECUTE FUNCTION goat.enforce_codex_chat_turn_execution_binding();
