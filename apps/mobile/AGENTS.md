You're working on the opencompany mobile app built using React Native and Expo 57.

We support only iOS 26+ for now (that has Liquid Glass support—Apple's new design language). 

## Docs

React Native ecosystem changes quickly. Your knowledge about Expo and used libraries is probably outdated.

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

We use `@expo/ui` library to access some native SwiftUI components. Use `sosumi` skill to look up actual Apple Developer documentation for SwiftUI, Liquid Glass, etc. and dedicated `swiftui-expert-skill`.

## Styling

Styling is done using Uniwind that allows us to use Tailwind class names in React Native. Always use `uniwind` skill when working with styles. The theme is defined in `src/global.css`: supports standard Tailwind V4 class names + a few custom styles based on our design system.

Never use RN's StyleSheet or useColorScheme. Always prefer `classNames` prop to style components, or `useUniwind` and other hooks. It's okay to use `style` prop for Reanimated props or dynamic values, but don't overuse it.

Avoid hardcoding theme values, like colors, and use `classNames` (or `useResolveClassNames` or `useCSSVariable`) to get proper values (will be updated on theme change).

We have a library of styled components wrapped `withUniwind` in `src/shared/ui`. For 3rd party components that don't support classNames or have other custom styling, create reusable styled components in that folder.

Use `size-*` utility instead of `h-* w-*` with same values.

### Dark Mode

The app supports dark mode. Theme is switched automatically based on the system settings. When styling components, always think about the dark mode and use `dark:*` classNames when needed.

### Native UI

We prefer using native UI components where possible to achieve the best performance and native feel. Use `expo-native-ui` skill to learn about this approach, and `expo-ui` skill to understand how `@expo/ui` library works.

Use the `apple-design` when implementing iOS UI to get recent Apple design guidelines. Use `write-swift` skill to write performant native Swift code.

### Native modules and wrappers

- Small native views live next to their feature as Expo inline modules. Each directory is listed in
  `experiments.inlineModules.watchedDirectories` in `app.config.ts`, and each Swift file, class,
  and registered `Name` must match. Current modules: the sidebar header
  (`src/widgets/sidebar/native`), the Magic Replace symbol (`src/shared/ui/animated-symbol`), and
  in `src/widgets/chat/native` the photo picker pre-warm and the composer input
  (`NativeComposerInput`). The composer input is a `UITextView` that holds quick action tags as single
  attachment characters, so a tag is atomic. Send it commands only after its first `onLayout`;
  commands sent from the commit that mounts it are dropped. Its text view must stay a direct child
  of the Expo view, because keyboard-controller reads the focused input's `nativeID` from the text
  view's superview.
  Adding a module or a native package needs `bun run prebuild:ios` and a rebuild.
- `expo-camera` powers the composer's camera panel and `expo-glass-effect` its Liquid Glass
  surfaces. Use the `StyledCameraView`, `StyledGlassView`, and `StyledGlassContainer` wrappers in
  `src/shared/ui`. Never fade a glass view or its parent to zero opacity; switch
  `glassEffectStyle` to `none` instead. Glass that mounts inside a parent that is still fading
  in must start as `none` and switch to `regular` once the parent is fully shown: UIKit drops
  glass set up at low opacity and never restores it. Offer an opaque fallback when Reduce
  Transparency is on.
- In a form sheet with fractional detents, make the scroll view the screen's root view. A sheet
  tracks only a scroll view it finds there; one wrapped in another view stops painting when the
  sheet changes detent. The chat detail sheets (`tool-sheet`, `reasoning-sheet`) follow this.
- Wrap components with a prop ending in `Style` that is not a style (like `glassEffectStyle`)
  using `withUniwind(Component, { style: { fromClassName: "className" } })`. The automatic mode
  turns every `*Style` prop into a style array, which silently breaks the native prop.

## Local storage

Chats, drafts, attachments, and the outbox live in the `opencompany-chat.db` SQLite database
(`src/widgets/chat/model/chat-storage`). `PRAGMA user_version` tracks the schema, and
`database.ts` applies each migration in `migrations.ts` in order. Migrations are additive: add
nullable columns so rows written by older builds keep working, bump the version, and raise the
"newer than this app" guard. Version 5 added `drafts.selection_json` (engine, model, and settings
per draft) and `conversations.composer_settings_json` (the server's last composer settings).
Version 6 added `drafts.mentions_json`: the skill, workflow, and Task mentions behind the draft's
tags. Version 7 clears every `messages.presentation_etag` once, so cached presentations refetch
with reasoning, nested traces, and complete tool payloads. Draft text stores tags serialized, and `parseDraftSegments` turns them back into tags.
Outbox message intents freeze the engine payload when queued; intents without one are Chat.

## Routing

We use Expo Router with file-based navigation. The API is similar to React Navigation, but recently started diverging from it, so always use `expo-router` skill when working with routing and linking.

## Animations

We use Reanimated 4 for animations. Never use `Animated` from RN, only `import Reanimated from "react-native-reanimated"`. Always offload animations to UI thread using Reanimated or Worklets.
Use `animate-expo` skill to find appropriate animation opportunities and craft delightful animations.

## React Compiler

React Compiler is enabled in the mobile app. Don't use `useMemo`, `useCallback`, or `memo` unless the compiler doesn't do so (rare) - only after debugging performance issues.

## Coding Style

- Use `until-async` for async error handling
- Prefer `interface` over `type`
- Do not create separate interfaces for props, just inline the type definition in the function component
- Do not use nested function declarations, only use arrow functions inside other functions
- Use `Boolean()` instead of `!!`, and for boolean-type conversions
- No testing is implemented in the mobile app for now. Don't write unit or E2E tests unless explicitly asked to by the user.

## Device Testing

Do not use a simulator or a preview to verify the app unless the user requests that explicitly. Use agent-device only for app/device automation tasks. For a normal app-driving task, start immediately. Do not probe first with `--help`, `--version`, `devices`, `appstate`, `snapshot`, or `screenshot`; open the requested app in the foreground and continue from its initial interactive snapshot. For TV, Fire TV, or Vega OS tasks, read `agent-device help tv`. For exploratory QA, read `agent-device help dogfood`. For logs, network, audio, traces, or runtime failures, read `agent-device help debugging`. For React Native component trees, props/state/hooks, slow renders, or rerenders, read `agent-device help react-devtools`. For React Native JavaScript heap growth, heap snapshots, allocation hotspots, or retained-object leaks, read `agent-device help cdp`. For React Native apps, overlays, Metro/Fast Refresh blockers, and routing to React DevTools or debugging evidence, read `agent-device help react-native`.

Use the CLI in the integrated terminal. `agent-device` is installed as a dev dependency, so run via `bun agent-device <subcommand>` in the `apps/mobile` directory. Do not assume the agent process `PATH` is the user's `PATH`. Do not silently fall back to `bunx agent-device@latest`; ask or use an exact version. See correct bundle identifier in the Expo config in `app.config.ts` (we use the dev version of the app for development). Prefer `open -> snapshot -i -> act -> re-snapshot -> verify -> close` where the target supports capture and selectors; otherwise follow target-specific help. Use current refs such as `@e3` for exploration and selectors for durable replay. Keep mutating commands against one session serial. Capture screenshots, logs, network, audio, perf, traces, recordings, and `.ad` replay scripts only when they add evidence.

If the app is not authenticated, do not try to silently get around, but explicitly asked the user to sign in to properly test the app.

## Data Fetching

Use TanStack Query for data fetching and async state management (even if it doesn't involve fetch).

## Analytics

When adding a feature, check whether its key user actions, outcomes, and failures need a PostHog event. Never capture message contents, file names, or other sensitive user data.
