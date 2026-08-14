# GitHub integration local development

Use a dedicated development GitHub App and the stable public tunnel started by `bun run dev:web`.
The app needs repository metadata plus the Contents, Pull requests, and Issues permissions required
by the opencompany coding flows.

Configure these routes on the development app, replacing the origin with the tunnel URL:

```text
https://your-domain.example/api/integrations/github/callback
https://your-domain.example/auth/callback
```

Store the GitHub App OAuth, state, and webhook values with the local API inputs in Infisical `dev`
`/goat`; the runner also needs the App ID and private key for coding operations. `bun run setup`
distributes the local values to the API, runner, and web relay configuration. In production the full
provider-ingress set belongs to `prod` `/api`, while the runner keeps only its execution credentials.

The stable web URLs are continuity relays. The API verifies state and webhook signatures, performs
the OAuth exchange, applies tenancy policy, and persists the connection. The runner receives scoped
installation or user credentials for the authorized coding operation; the browser never receives
the App private key or webhook secret.

Run `bun run dev:web`, open the web app through the public origin, sign in, connect GitHub from settings,
and exercise the repository action or coding workspace under test. For parallel worktrees, keep
Neon branches isolated and use distinct static tunnel domains/GitHub Apps when flows must run at the
same time.
