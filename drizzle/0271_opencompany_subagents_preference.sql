-- Subagents: per-member opt-in for delegated research in the opencompany chat engine.
--
-- Additive and reversible. Defaults to false, so no existing member gains the
-- run_subagent tool until they turn the Subagents switch on in Preferences.
-- Replaces the RUNNER_OPENCOMPANY_SUBAGENTS_ENABLED deployment gate, which was
-- never enabled in any environment, so there is no state to carry over.

ALTER TABLE "goat"."users" ADD COLUMN "subagents_enabled" boolean DEFAULT false NOT NULL;
