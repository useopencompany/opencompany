# ACP support in coding sandboxes

opencompany is the ACP client for the Codex and Claude Code adapters that run in coding
sandboxes. The runner speaks ACP protocol version 1 and turns provider-neutral ACP messages into
durable chat events before the web app renders them.

This document records the supported wire surface. It distinguishes protocol compatibility from
product presentation: an update can be accepted and safely ignored even when the chat UI has no
corresponding control.

## Agent methods

| Client-to-agent method | Status | opencompany behavior |
| --- | --- | --- |
| `initialize` | Supported | Negotiates protocol version 1 and advertises the runner's client capabilities. |
| `session/new`, `session/load` | Supported | Creates or resumes the adapter session. Historical updates replayed by `session/load` are drained before live projection starts. |
| `session/prompt` | Supported | Sends text, image, and resource-link prompt blocks and consumes the streamed turn. |
| `session/set_config_option` | Supported | Applies model, reasoning effort, permission mode, and collaboration mode when the adapter advertises the matching option. |
| `session/cancel` | Supported | Cancels a turn after a user interruption, timeout, shutdown, or lost lease. |
| `authenticate`, `logout` | Not used | opencompany stages provider authentication in the sandbox before starting the adapter. |
| `session/list`, `session/delete`, `session/resume`, `session/close` | Not used | Durable chat sessions own lifecycle and resume through `session/load`. |
| `session/set_mode` | Not used | Current adapters expose their mode through `session/set_config_option`. |

Codex steering and Goal controls use capability-negotiated extension methods. The runner does not
call an extension unless the adapter advertises the corresponding capability or is configured with
the adapter's known steering method.

## Client methods

| Agent-to-client method | Status | opencompany behavior |
| --- | --- | --- |
| `session/request_permission` | Supported | Creates a durable one-time approval, waits for the user's choice, and returns the matching ACP option ID. `allow_once` and `reject_once` are preferred when the agent supplies them; there is no persistent “always allow” product control. |
| `elicitation/create` (`form`) | Supported with limits | Creates a durable question for up to three flat primitive fields. Supports strings, numbers, integers, booleans, titled single-selects, and one selection from a titled multi-select. Codex and Claude companion “Other” fields are folded into the related question. |
| `elicitation/create` (`url`) | Supported | Presents the message and URL as a durable accept/decline question. The agent remains responsible for observing completion of the external flow. |
| `elicitation/complete` | Accepted | The notification is accepted. The durable URL question has already been resolved when the user accepts or declines it, so no additional UI transition is applied. |
| `fs/read_text_file`, `fs/write_text_file` | Not advertised | Sandbox agents access their shared checkout directly. The runner does not advertise ACP filesystem RPCs. |
| `terminal/*` | Not advertised | Sandbox agents execute through their own runtime. The runner advertises `terminal: false`. |

Unknown extension requests receive JSON-RPC `-32601`. Unknown notifications are ignored.

## Session updates

| `sessionUpdate` variant | Status | Durable projection |
| --- | --- | --- |
| `agent_message_chunk` | Supported | Assistant text, including nested subagent text when parent metadata is present. |
| `agent_thought_chunk` | Supported | Reasoning item. |
| `tool_call`, `tool_call_update` | Supported | Command, file change, web search, subagent, or generic tool lifecycle. Text content, diffs, locations, raw input/output, and provider metadata are retained where useful. |
| `plan` | Supported | Plan item. The pre-standard `plan_update` spelling is also accepted. |
| `usage_update` | Supported | Context-window usage and cost metadata. Prompt-result token usage is handled separately. |
| `session_info_update` | Partially supported | Goal metadata is projected. Titles, timestamps, and other session metadata remain owned by the opencompany chat session. |
| `user_message_chunk` | Accepted, not projected | New user input is already stored by opencompany; loaded-session replay is drained before projection to avoid duplicates. |
| `available_commands_update` | Accepted, not projected | Coding-chat commands are not currently exposed in the composer. |
| `current_mode_update` | Accepted, not projected | The composer uses opencompany's selected run mode. |
| `config_option_update` | Accepted, not projected | The composer uses opencompany's persisted engine settings. |

## Content blocks

Text, images, and resource links are supported in prompts. Audio and embedded-resource prompt
blocks are not currently constructed by the runner. Assistant and reasoning chunks project text;
non-text chunk content is accepted without a transcript part. Tool results project text content and
file diffs, while image, audio, resource-link, embedded-resource, and terminal content do not yet
have durable chat projections.

## Known form-elicitation limits

ACP form elicitation supports a wider restricted JSON Schema surface than the current durable
question component. opencompany currently declines forms with more than three logical fields,
unknown property types, arrays without titled choices, or values that cannot be represented by the
question component. The UI requires an answer for every rendered field even when the ACP schema
marks it optional. Defaults, regex patterns, numeric step controls, multiple selections in one
array field, and adapter-specific option previews are not rendered. Secret credentials should use
ACP URL elicitation rather than form fields.

The Claude adapter is pinned deliberately because its mapping is part of this compatibility
boundary. Version 0.71.0 fixed cancellation of pending permission and elicitation requests when a
steering message arrives; opencompany runs 0.76.0, which includes that fix.
