# OpenCompany mobile

The mobile app is an Expo 57 iOS app using Expo Router, Uniwind, and native
`@expo/ui` components. Mobile AuthKit v1 authenticates directly with WorkOS
using PKCE; it does not call an OpenCompany backend.

## Local setup

Create `apps/mobile/.env` with a WorkOS public client ID:

```dotenv
APP_VARIANT=development
EXPO_PUBLIC_WORKOS_CLIENT_ID=client_...
```

The client ID is safe to ship in the mobile binary. Do not add a WorkOS API
key to this file or to the mobile app.

`APP_VARIANT=development` resolves the development configuration to:

- scheme: `opencompany-dev`
- bundle identifier: `cloud.opencompany.mobile-dev`

Any other value, including `production`, resolves the production configuration:

- scheme: `opencompany`
- bundle identifier: `cloud.opencompany.mobile`

## WorkOS redirect URIs

Add both of these redirect URIs to the WorkOS AuthKit configuration:

```text
opencompany-dev://callback
opencompany://callback
```

The app derives the callback from the scheme compiled into its Expo config.
Changing `APP_VARIANT` changes the native scheme, so rebuild the development
client after changing it:

```bash
bun run --cwd apps/mobile prebuild:ios
bun run --cwd apps/mobile ios
```

Then start the app against the development client:

```bash
bun run --cwd apps/mobile start -- --dev-client
```

## Checks

```bash
bun run --cwd apps/mobile typecheck
```

The native splash remains visible while the stored WorkOS session is restored
or refreshed. A browser cancellation returns to the idle sign-in screen. A
successful login opens `/`, which contains the authenticated drawer and stack.
