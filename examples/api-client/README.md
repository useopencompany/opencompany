# Typed API client example

This example uses the generated `@opencompany/protocol` client to create a Conversation with its
first Message and consume the resulting typed Run event stream. The `/v1` contract creates the
Conversation and first Message atomically, so there is no separate empty-Conversation request.

Supply an opencompany API origin and a WorkOS access token whose audience matches the API:

```bash
OPENCOMPANY_API_URL=https://api.example.com \
OPENCOMPANY_API_TOKEN=replace-me \
bun --filter @opencompany/example-api-client start
```

Set `OPENCOMPANY_MESSAGE` to replace the example prompt. A community-mode checkout boots the API
contract and health routes, but this authenticated model-backed flow also needs your own WorkOS and
model-provider configuration.
