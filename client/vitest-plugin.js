/**
 * Vitest config plugin for projects using @codemagic/react-native-patch.
 *
 *   import { codemagicPatch } from '@codemagic/react-native-patch/vitest-plugin';
 *   export default defineConfig({ plugins: [codemagicPatch()], ... });
 *
 * The package's default entry is a CommonJS build. Vitest leaves that to
 * Node's `require`, which its module mocks never see, so the `react-native`
 * mock from `@codemagic/react-native-patch/vitest` would not reach the SDK.
 * This plugin points the package entry at its TypeScript source instead, which
 * Vitest transforms and mocks like your own code. Nothing else is aliased.
 */
const path = require("node:path");

exports.codemagicPatch = function codemagicPatch() {
  return {
    name: "codemagic-patch",
    config() {
      return {
        resolve: {
          alias: [
            {
              find: /^@codemagic\/react-native-patch$/,
              replacement: path.join(__dirname, "src", "index.ts"),
            },
          ],
        },
      };
    },
  };
};
