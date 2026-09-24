import { build } from "esbuild";

// Bundle the Electron main and preload entry points to CommonJS in dist/.
// Only `electron` stays external. electron-updater is bundled so the packaged
// app ships no node_modules and electron-builder has no dependency tree to
// collect from the Bun workspace.
const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
  logLevel: "info",
};

await Promise.all([
  build({ ...shared, entryPoints: ["src/main.ts"], outfile: "dist/main.js" }),
  build({ ...shared, entryPoints: ["src/preload.ts"], outfile: "dist/preload.js" }),
]);
