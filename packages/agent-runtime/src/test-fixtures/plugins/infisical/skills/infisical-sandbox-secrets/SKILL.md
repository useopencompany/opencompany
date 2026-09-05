---
name: infisical-sandbox-secrets
description: "Safely use the workspace-authenticated Infisical CLI in an opencompany coding sandbox to inject secrets into a process, export an environment to a protected local file, or create and update secrets. Use when a task needs env values from Infisical, `infisical run`, an Infisical-backed `.env` file, or a secret write."
---

# Infisical sandbox secrets

Use the Infisical CLI that opencompany prepares for the workspace. The hosted Infisical MCP server
is for current documentation; it does not receive workspace credentials or return secrets. Consult
its tools when command syntax or provider behavior needs verification, then perform secret access
with the CLI.

Never print, log, summarize, quote, or paste secret values into chat or tool arguments. Prefer
injecting secrets only into the process that needs them. Create, update, or delete secrets only when
the user explicitly asks for that mutation and has supplied the exact target.
