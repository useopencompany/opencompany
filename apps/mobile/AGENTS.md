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

### Dark Mode

The app supports dark mode. Theme is switched automatically based on the system settings. When styling components, always think about the dark mode and use `dark:*` classNames when needed.

### Native UI

We prefer using native UI components where possible to achieve the best performance and native feel. Use `expo-native-ui` skill to learn about this approach, and `expo-ui` skill to understand how `@expo/ui` library works.

## Routing

We use Expo Router with file-based navigation. The API is similar to React Navigation, but recently started diverging from it, so always use `expo-router` skill when working with routing and linking.

## Animations

We use Reanimated 4 for animations. Never use `Animated` from RN, only `import Reanimated from "react-native-reanimated"`. Always offload animations to UI thread using Reanimated or Worklets.

## React Compiler

React Compiler is enabled is the mobile app. Don't use `useMemo`, `useCallback`, or `memo` unless the compiler doesn't do so (rare) - only after debugging performance issues.

## Coding Style

- Prefer `interface` over `type`
- Do not create separate interfaces for props, just inline the type definition in the function component
