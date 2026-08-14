# Agent turn vocabulary

OpenCompany's canonical execution terms are `Conversation`, `Message`, `Run`, `Attempt`, and
`Event`. The versioned contract in `packages/protocol` and the application services in
`packages/core` define their behavior. See
[ADR 0001](./adr/0001-headless-chat-v1-foundation.md) for the authoritative Chat model.

Some retained first-generation database fields use older turn-dispatch names. In particular,
`agent_session_messages.send_mode` records the historical `steer`, `queue`, and `interrupt` values.
That physical compatibility field is not a second Chat protocol and should not be used by new
clients or product code. New work sends idempotent Message commands and observes the resulting Run
through `/v1`.
