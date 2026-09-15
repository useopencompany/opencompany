-- A delivered steering message is projected into the running turn's transcript as its own event.
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
		'turn.started', 'turn.completed', 'usage.updated', 'steering.delivered', 'error', 'unknown'
	));
