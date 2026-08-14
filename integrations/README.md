# Provider deployment projects

`integrations/` owns provider-side deployment definitions that configure external platforms to call
the opencompany API. Runtime OAuth, webhook verification, authorization, and persistence still live
in `apps/api`/`apps/runner`; these projects are not additional product backends.

Current project:

- [`hubspot/`](./hubspot/) — HubSpot public OAuth app metadata and webhook subscriptions.

Provider uploads and deploys change external state. Resolve the exact provider account/project,
validate locally with the provider CLI, and obtain the integration owner's approval before running a
deploy command. Never commit provider CLI credentials or `local.json` overrides.
