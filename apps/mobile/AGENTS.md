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
- No testing is done in the mobile app for now. Don't write tests unless explicitly asked to by the user.

## Device Testing

Do not use a simulator or preview unless user requests it explicitly to verify the app. Use agent-device only for app/device automation tasks. For a normal app-driving task, start immediately. Do not probe first with `--help`, `--version`, `devices`, `appstate`, `snapshot`, or `screenshot`; open the requested app in the foreground and continue from its initial interactive snapshot. For TV, Fire TV, or Vega OS tasks, read `agent-device help tv`. For exploratory QA, read `agent-device help dogfood`. For logs, network, audio, traces, or runtime failures, read `agent-device help debugging`. For React Native component trees, props/state/hooks, slow renders, or rerenders, read `agent-device help react-devtools`. For React Native JavaScript heap growth, heap snapshots, allocation hotspots, or retained-object leaks, read `agent-device help cdp`. For React Native apps, overlays, Metro/Fast Refresh blockers, and routing to React DevTools or debugging evidence, read `agent-device help react-native`.

Use the CLI in the integrated terminal. `agent-device` is installed as a dev dependency, so run via `bun agent-device <subcommand>`. Do not assume the agent process `PATH` is the user's `PATH`. Do not silently fall back to `bunx agent-device@latest`; ask or use an exact version. Prefer `open -> snapshot -i -> act -> re-snapshot -> verify -> close` where the target supports capture and selectors; otherwise follow target-specific help. Use current refs such as `@e3` for exploration and selectors for durable replay. Keep mutating commands against one session serial. Capture screenshots, logs, network, audio, perf, traces, recordings, and `.ad` replay scripts only when they add evidence.

## Data Fetching

Use TanStack Query for data fetching and async state management (even if it doesn't involve fetch).
