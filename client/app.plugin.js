// Expo config-plugin entry point. Expo resolves `@codemagic/patch-client/app.plugin.js`
// (bypassing the package `exports` map only when `./app.plugin.js` is exported —
// which it is). Points at the compiled plugin. The `prepare` script builds
// `plugin/build` on install/pack/publish; source consumers (portal:/workspace:)
// must run `yarn build` before prebuild (see README § Expo framework apps).
module.exports = require('./plugin/build/withCodemagicPatch').default;
