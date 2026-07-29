-- Claude Code Task (subagent) calls now project as first-class subagent.started /
-- subagent.completed events so the chat UI can render a subagent's nested trace. Extend both
-- codex event audit tables' type checks so persisting these events cannot be rejected.
ALTER TABLE "goat"."local_codex_events"
	DROP CONSTRAINT IF EXISTS "goat_local_codex_events_type_check";
--> statement-breakpoint
ALTER TABLE "goat"."local_codex_events"
	ADD CONSTRAINT "goat_local_codex_events_type_check"
	CHECK ("local_codex_events"."type" IN (
		'assistant.delta', 'assistant.completed', 'reasoning.completed',
		'command.started', 'command.output', 'command.completed', 'command.failed',
		'file_change.started', 'file_change.completed',
		'mcp_tool.started', 'mcp_tool.completed',
		'subagent.started', 'subagent.completed',
		'dynamic_tool.started', 'dynamic_tool.completed',
		'web_search.started', 'web_search.completed',
		'plan.updated', 'goal.updated', 'question.requested', 'approval.requested',
		'turn.started', 'turn.completed', 'usage.updated', 'error', 'unknown'
	));
--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_events"
	DROP CONSTRAINT IF EXISTS "goat_codex_chat_events_type_check";
--> statement-breakpoint
ALTER TABLE "goat"."codex_chat_events"
	ADD CONSTRAINT "goat_codex_chat_events_type_check"
	CHECK ("codex_chat_events"."type" IN (
		'assistant.completed', 'reasoning.completed',
		'command.started', 'command.completed', 'command.failed',
		'file_change.started', 'file_change.completed',
		'mcp_tool.started', 'mcp_tool.completed',
		'subagent.started', 'subagent.completed',
		'dynamic_tool.started', 'dynamic_tool.completed',
		'web_search.started', 'web_search.completed',
		'plan.updated', 'goal.updated', 'question.requested', 'approval.requested',
		'turn.started', 'turn.completed', 'usage.updated', 'error', 'unknown'
	));
