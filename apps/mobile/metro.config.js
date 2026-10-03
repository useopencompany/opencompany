const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");
const { withSentryConfig } = require("@sentry/react-native/metro");
const { getDefaultConfig } = require("expo/metro-config");
const { getBundleModeMetroConfig } = require("react-native-worklets/bundleMode");
const { withUniwindConfig } = require("uniwind/metro");

/** @type {import('expo/metro-config').MetroConfig} */
let config = getDefaultConfig(__dirname);

const workletsDirectory = fs.realpathSync(
  path.resolve(__dirname, "node_modules/react-native-worklets/.worklets"),
);
config.watchFolders.push(workletsDirectory);

const workletsCacheVersionFile = path.join(workletsDirectory, ".metro-cache-version");
const hasGeneratedWorklets = fs.readdirSync(workletsDirectory).some((file) => file.endsWith(".js"));
// Expo overrides resetCache, so invalidate transforms with a token stored beside their
// generated files. Worklets ships dummy.md even when no generated JavaScript exists.
if (!hasGeneratedWorklets || !fs.existsSync(workletsCacheVersionFile)) {
  fs.writeFileSync(workletsCacheVersionFile, randomUUID());
}
// Keep transforms separate across worktrees and renew them after generated files disappear.
config.cacheVersion = `${config.cacheVersion}:${workletsDirectory}:${fs.readFileSync(workletsCacheVersionFile, "utf8")}`;

config = withUniwindConfig(config, {
  cssEntryFile: "./src/global.css",
  dtsFile: "./src/uniwind-types.d.ts",
});

config = getBundleModeMetroConfig(config);

// Worklets' React Native shim and Uniwind's component shim otherwise resolve
// through each other forever. Metro cannot break that resolver cycle itself,
// so imports originating inside Uniwind must resolve React Native directly.
const uniwindDirectory = `${path.dirname(require.resolve("uniwind/package.json"))}${path.sep}`;
const reactNativePath = require.resolve("react-native");
const resolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "react-native" && context.originModulePath.startsWith(uniwindDirectory)) {
    return { type: "sourceFile", filePath: reactNativePath };
  }

  return (resolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

config = withSentryConfig(config, {
  includeWebReplay: false,
  includeWebFeedback: false,
  autoWrapExpoRouterErrorBoundary: true,
});

module.exports = config;
