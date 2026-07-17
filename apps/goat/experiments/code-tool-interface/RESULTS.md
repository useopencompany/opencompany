# Measured result

Run on 2026-07-17 with `anthropic/claude-sonnet-5`, one repetition of the shared 15-task tool-exposure corpus, and the shared catalog of 100 schemas (20 each for Linear, Attio, Slack, GitHub, and Notion).

| Strategy | Passed | Input tokens/task | Output tokens/task | Total tokens/task | Model round-trips/task | Model-visible tool calls/task |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Execute-only | 8/15 (53%) | 1,311 | 872 | 2,183 | 1.00 | 1.00 |
| Flat schemas | 14/15 (93%) | 47,057 | 611 | 47,668 | 3.00 | 2.40 |
| Lazy tiered | 15/15 (100%) | 8,155 | 706 | 8,861 | 4.53 | 5.20 |

On successful runs only, execute averaged 2,339 total tokens versus 46,588 for flat and 8,861 for tiered. This avoids making the execute token win look better merely because some programs failed early. Execute still used 95% fewer total tokens than flat and 74% fewer than tiered among successful cases.

For the two tasks requiring at least three integration calls (`crm-decision-announce` and `five-source-digest`), execute averaged 1 model round-trip, flat 3.5, and tiered 5.5. Execute passed one of the two; both baselines passed both. The five-source fan-out is the clearest positive result: execute searched and described five paths, invoked all five in parallel, and completed in one provider request with 3,212 total tokens. The sequential CRM task returned before invoking anything.

## Reliability and traces

Execute failures were easy to classify from generated code plus the catalog trace:

- Three malformed inputs after schema discovery: missing `attio.search_records.object`, `linear.create_issue.teamKey`, and `slack.add_reaction.channelId`.
- Four programs stopped after discovery or description without invoking the required operation.
- No syntax errors, unknown tool paths, timeouts, process crashes, or tool-side failures occurred in the shared final run. A separate fault-injection probe is described below.

Execute searched 34 times, described 29 paths, and invoked 21 paths. Eight described paths were never invoked. Tiered searched 25 times, described 27 paths, invoked 26 paths, and over-fetched one path. Generated JavaScript increased output tokens (872/task versus 611 flat and 706 tiered), but the input-context savings dominated total tokens.

Flat's one failure was also clear: it called `slack.list_channels` three times for the implicit “company chat destination called announcements” prompt, then asked the user for clarification instead of using `slack.send_message`. Tiered recovered the implicit integration and completed it.

The execute trace was at least as diagnosable as normal tool calling for this mock: it preserved the exact program, stdout/stderr-style logs, search rankings, loaded schemas, validated inputs, returned values, failure category, and stack. The main debugging downside is volume—the successful programs were often verbose, schema-reflective JavaScript.

## Tool-error fault probe

The separate `fault-recover-tool-error` probe forced a GitHub branch-protection rejection and required its exact error to be sent to Slack. Flat completed it in 4 model round-trips and 63,448 tokens; tiered completed it in 6 model round-trips and 16,621 tokens. Execute used 1 model round-trip and 2,397 tokens, but failed the semantic oracle: its generated code malformed the merge input (`pullNumber` was missing), then reported that validation error to Slack instead of reaching and reporting the seeded branch-protection rejection. This is another instance of the same unseen-schema reliability problem, not a sandbox failure.

## Decision

Do not replace Goat's tiered approach with execute-only yet. The round-trip and context wins are large and real, but 53% reliability is not acceptable for user-facing actions. The central weakness is architectural: runtime `describe` results arrive after the model has already generated the program, so the program must interpret arbitrary schemas correctly with generic reflection. Sonnet often omitted a required field or treated discovery as a staged interaction.

The promising follow-up is a hybrid: use deterministic/tiered retrieval before code generation to select a small tool set and materialize typed stubs inside the sandbox, then ask the model for one program that chains those known tools. That preserves most of the one-round-trip execution advantage without requiring generated code to infer unseen schemas. A second option is allowing one discovery execute followed by one action execute; it weakens the one-round-trip claim but may still beat per-tool turns.

Before any product decision, run at least five repetitions on the final prompt, test Goat's other candidate models, add injected tool-side failures, and repeat against real-shaped pagination/empty/auth responses. Production work would also require a real isolate or microVM, capability and approval enforcement per call, no ambient host authority, egress controls, quotas, external secret brokering, cancellation, and durable audit logs.

Raw traces for this run are gitignored at:

- `.context/code-tool-interface/execute-final.json`
- `.context/code-tool-interface/baselines-final.json`
- `apps/goat/.context/code-tool-interface/fault-final.json` (flat and tiered traces)
- `.context/code-tool-interface/fault-execute-authoritative.json` (execute trace with the hardened semantic oracle)
