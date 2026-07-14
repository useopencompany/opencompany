-- Pinned chats in the Goat sidebar: pinned_at orders the pinned section
-- (most recently pinned first) and NULL means unpinned.
ALTER TABLE "goat"."chat_sessions" ADD COLUMN IF NOT EXISTS "pinned_at" timestamp with time zone;
