/** @type {import("react-native-worklets/plugin").PluginOptions} */
const workletsPluginOptions = {
  bundleMode: true,
  strictGlobal: true,
  importForwarding: {
    moduleNames: ["remend"],
  },
};

module.exports = function configureBabel(api) {
  api.cache(true);

  return {
    presets: ["babel-preset-expo"],
    plugins: [["react-native-worklets/plugin", workletsPluginOptions]],
  };
};
