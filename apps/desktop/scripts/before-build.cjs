// scripts/build.mjs bundles all runtime code into dist/, so the app ships no
// node_modules. Returning false tells electron-builder that dependencies are
// handled externally; otherwise it copies the Bun workspace's hoisted
// node_modules (hundreds of MB) into app.asar.
exports.default = () => false;
