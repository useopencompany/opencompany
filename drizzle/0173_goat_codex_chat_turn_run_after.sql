ALTER TABLE "goat"."codex_chat_turns"
ADD COLUMN IF NOT EXISTS "run_after" timestamptz;
