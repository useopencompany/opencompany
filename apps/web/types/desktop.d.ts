// ContextBridge global exposed by the Electron shell's preload
// (see apps/desktop/src/preload.ts). Absent in normal browsers, so every access
// must be optional-chained and gracefully fall back to the web sign-in flow.
export {};

declare global {
  interface Window {
    opencompanyDesktop?: {
      version: string;
      platform: "darwin";
      // Opens Google sign-in in the system browser via the PKCE handoff.
      signInWithGoogle: () => void;
    };
  }
}
