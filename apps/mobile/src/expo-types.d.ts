// Expo generates `expo-env.d.ts` with this reference on the first local run, and that file is
// gitignored, so a clean checkout (CI) would otherwise miss Expo's ambient module declarations
// for CSS and asset imports.
/// <reference types="expo/types" />
