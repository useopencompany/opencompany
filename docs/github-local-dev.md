# GitHub integration local development

Use a dedicated development GitHub App and the stable public tunnel started by `bun run dev:web`.
The app needs repository metadata plus the Contents, Pull requests, and Issues permissions required
by the OpenCompany coding flows.

Configure these routes on the development app, replacing the origin with the tunnel URL:

```text
https://your-domain.example/api/integrations/github/callback
https://your-domain.example/auth/callback
```

Store `GITHUB_INTEGRATION_APP_*` and `GITHUB_INTEGRATION_STATE_SECRET` in Infisical `dev` `/goat`
and `/runner` where consumed. `bun run setup` mirrors the web values locally. The runner receives
short-lived installation/user credentials through the authenticated web flow; it does not use the
retired repository-storage installation.

Run `bun run dev:web`, open the web app through the public origin, sign in, connect GitHub from settings,
and exercise the repository action or coding workspace under test. For parallel worktrees, keep
Neon branches isolated and use distinct static tunnel domains/GitHub Apps when flows must run at the
same time.
