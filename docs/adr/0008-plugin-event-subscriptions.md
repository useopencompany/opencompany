# ADR 0008: Declarative Plugin Event Subscriptions

- Status: Accepted
- Date: 2026-09-05
- Extends: [ADR 0006](./0006-gateway-plugins-and-integrations.md)

## Context

The platform already verifies Linear webhooks, binds deliveries to connected accounts, and
durably materializes workflow tasks. Event vocabulary and matching were nevertheless hardcoded to
one `issue_enters_triage` trigger, so plugins could distribute tools and skills but could not
describe events their provider emits.

## Decision

Trusted official packages may declare event contracts in `so.opencompany.events`. Each declaration
contains a stable event ID, user-facing label and description, a platform-supported delivery mode,
and declarative integration-resource filters. The same trusted-source gate used for
`so.opencompany.capabilities` applies: third-party declarations remain in the manifest for
round-tripping but are never honored.

Plugins publish vocabulary only. Provider ingress remains platform code and continues to own
signature verification, tenant and connection binding, payload normalization, filtering,
idempotency, and durable enqueueing. No plugin code runs while accepting a delivery.

Each installed plugin stores sparse workspace event modes separately from its immutable package.
Missing entries are off. Modes survive archive and reinstall, and disabling either the plugin or
an event stops new matches without canceling already-enqueued runs.

Workflow event triggers use the provider-independent shape
`{ type, provider, event, integrationId, filters, prompt }`. Authoring validates that the account is
connected and that an enabled installed plugin declares the event and its filters. The Linear v1
contract exposes `issue.created` with a required team filter. Existing
`linear/issue_enters_triage` rows are read through a compatibility alias and continue to fire
without requiring the new toggle.

## Consequences

Adding a webhook-backed event now requires a reviewed manifest declaration plus a platform ingress
adapter from the provider's signed envelope to that event ID. The durable worker and task
materialization path do not change. Polling-backed providers, webhook auto-registration, and
non-workflow subscribers remain out of scope.
