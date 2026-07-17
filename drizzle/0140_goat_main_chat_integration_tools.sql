-- Beta flag for connected-integration tools (Linear, GitHub) in Goat's
-- foreground main chat. Default off; toggled per user in Settings →
-- Preferences.
ALTER TABLE "goat"."users" ADD COLUMN IF NOT EXISTS "main_chat_integration_tools_beta_enabled" boolean DEFAULT false NOT NULL;
