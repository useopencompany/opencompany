const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const { getBundleModeMetroConfig } = require("react-native-worklets/bundleMode");
const { withUniwindConfig } = require("uniwind/metro");

/** @type {import('expo/metro-config').MetroConfig} */
let config = getDefaultConfig(__dirname);

config.watchFolders.push(path.resolve(__dirname, "node_modules/react-native-worklets/.worklets"));

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

module.exports = config;
