// Streaming polyfills for React Native, per the official AI SDK Expo guide:
// Hermes lacks structuredClone and TextEncoderStream/TextDecoderStream, which
// the AI SDK UI message stream parser needs.
import structuredClone from "@ungap/structured-clone";
import { Platform } from "react-native";

if (Platform.OS !== "web") {
  const setupPolyfills = async () => {
    // @ts-expect-error - internal RN utility without type declarations
    const { polyfillGlobal } = await import("react-native/Libraries/Utilities/PolyfillFunctions");
    const { TextDecoderStream, TextEncoderStream } = await import(
      "@stardazed/streams-text-encoding"
    );

    if (!("structuredClone" in globalThis)) {
      polyfillGlobal("structuredClone", () => structuredClone);
    }
    polyfillGlobal("TextEncoderStream", () => TextEncoderStream);
    polyfillGlobal("TextDecoderStream", () => TextDecoderStream);
  };

  setupPolyfills();
}

export {};
