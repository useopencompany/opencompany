# LLM token broker

The runner retains a scoped reverse proxy at `/broker/:provider/v1/*`. Sandboxed clients use opaque,
short-lived `ocbt_` tokens; real upstream provider credentials stay in the runner. Tokens are
hashed at rest, limited by provider/endpoint family, expiration, revocation, and budget.

`apps/runner/src/llm-broker.ts` validates and forwards requests. `llm-broker-usage.ts` parses usage,
and `llm-broker-tokens.ts` records requests and settles spend once. The retained physical tables are
modeled by `packages/db/src/llm-broker-schema.ts` and existing migrations. They are intentionally
outside the opencompany schema and must not be dropped during product cleanup.

The runner registers broker routes and the expired-token settlement sweep at startup. Provider keys
are server-only. Never inject `OPENAI_CODEX_API_KEY`, `VERCEL_AI_GATEWAY_API_KEY`, or database
credentials into a sandbox merely to bypass broker configuration.

Focused verification covers token hashing/validation, route scope, budget failures, streaming usage,
idempotent settlement, and the expiry sweep. A hosted smoke should additionally prove that the
sandbox sees only the scoped token and that one request produces one usage/debit record.
