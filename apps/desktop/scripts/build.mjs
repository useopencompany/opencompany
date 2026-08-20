import { build } from "esbuild";

// Bundle the Electron main and preload entry points to CommonJS in dist/.
// `electron` and `@todesktop/runtime` stay external so they resolve from
// node_modules at runtime (ToDesktop installs them on its remote builders).
const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron", "@todesktop/runtime"],
  logLevel: "info",
};

await Promise.all([
  build({ ...shared, entryPoints: ["src/main.ts"], outfile: "dist/main.js" }),
  build({ ...shared, entryPoints: ["src/preload.ts"], outfile: "dist/preload.js" }),
]);
