# Mobile development reference

Use this to identify the mobile environment before an explicitly requested device check.
The [mobile task map](../apps/mobile/AGENTS.md#task-map) owns code navigation.

## Identify the active environment

1. **Metro checkout and port.** Reuse Metro only if it serves this worktree. On macOS,
   `lsof -nP -iTCP -sTCP:LISTEN` finds listeners; inspect the candidate with
   `ps -p <pid> -o pid=,command=` and `lsof -a -p <pid> -d cwd -Fn`.
   Compare its working directory with this checkout's `apps/mobile`. Port 8081 is the usual
   default, not proof of ownership. `curl http://localhost:<port>/status` proves only that Metro
   responds. Leave another worktree's process alone and choose a free explicit port if needed.
2. **Reload mode.** Check how the selected Metro process was launched. `CI=1` disables Expo's
   interactive reload/watch behavior. When a new server is needed, run from `apps/mobile` with
   `env -u CI APP_VARIANT=development bun run start --dev-client --port <port>` in an interactive
   terminal. Unsetting CI in a different shell does not repair an already-running Metro process.
3. **API target.** Mobile exports development values with `bun run env:pull:development` from
   `apps/mobile`, using Infisical `dev` `/mobile`. Read only the public API origin, never dump the
   env file. `EXPO_PUBLIC_OPENCOMPANY_API_ORIGIN` is compiled into the JS bundle by Expo and read
   in `src/shared/api/opencompany-api.ts`. It must name the API you changed, normally local port
   3001 for simulator work; a physical device needs a reachable host instead of its own localhost.
   Confirm that API listener's checkout too. The production API cannot exercise local backend edits.
   Restart Metro after changing env and fully reload the app; verify an actual request's host.
4. **Native build.** `app.config.ts` selects `cloud.opencompany.mobile-dev` only when
   `APP_VARIANT=development`; the default is production. Expo dev-client uses `most-recent`, so
   opening the dev app can reconnect to another Metro. Select the intended server explicitly.
   JS/TS-only changes use Metro reload. Swift, native dependencies, config plugins, permissions,
   or inline module registration changes require `APP_VARIANT=development bun run prebuild:ios`
   followed by `APP_VARIANT=development bun run ios` from `apps/mobile`. Confirm the rebuilt dev
   binary was installed on the device being checked.
5. **Bundle proof.** After opening the selected server, trigger a full reload and confirm Metro
   receives the bundle request on that port. Exercise a visible effect of the current change or
   a temporary unique diagnostic marker, then remove the marker. Confirm the request host in
   network evidence. Record checkout, Metro port, API origin, and observed change with verification
   results. A successful build or an app already on screen does not prove which bundle loaded.
