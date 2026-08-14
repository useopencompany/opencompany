# Community development

The community path is a credential-free way to boot and test the three product runtimes. It is
development-supported; it is not production self-hosting guidance.

## Start and verify

With Bun `1.3.2` and Node `20.20.0` or newer:

```bash
bun install --frozen-lockfile
bun run dev:community
```

The command starts PGlite from `.opencompany/community-db`, applies the immutable Drizzle history,
and starts web, API, and runner. It needs no external database or container runtime. Stop it with
Ctrl-C. The database persists between runs; to reset it, stop the command and remove only
`.opencompany/community-db`.

In a second terminal:

```bash
bun run smoke:local
```

The smoke command polls `/healthz` on the API and runner, validates their service identities, and
reports their runtime mode. Override targets with `OPENCOMPANY_API_URL` and
`OPENCOMPANY_RUNNER_URL` when using custom ports.

## Capability limits

The community launcher keeps the local contract honest:

- WorkOS authentication is disabled, so health and OpenAPI boot but authenticated product routes
  need your own WorkOS project.
- Runner workers and model execution are disabled until you configure model/sandbox providers.
- Electric read-model sync, Redis presentation, Stripe, provider OAuth/webhooks, public tunnels, and
  hosted telemetry are disabled.
- PGlite multiplexes a single embedded Postgres process. Pool sizes are limited to one and this path
  is for development, tests, and contribution review, not production load or durability claims.

The launcher prints these limits and each health response exposes disabled capability reasons.

## Platform verification

Verified on 2026-08-14 in a fresh temporary clone on macOS 15.1 (Apple silicon), with the process
environment reduced to basic shell variables and no provider credentials. The verification covered
the frozen install, first migration of all 214 checked-in migrations, web/API/runner startup, web
health, API/runner smoke, clean shutdown, restart against the persistent PGlite directory, and the
example and docs typechecks. The second migration pass completed without rebuilding the database,
and the smoke check passed again after restart.

Linux still needs an independent clean-clone run on a current supported distribution covering the
same frozen install, first migration, restart, smoke, shutdown, and example/docs typechecks. Until
that evidence is recorded, Linux support is expected from the cross-platform dependencies but
unverified.
