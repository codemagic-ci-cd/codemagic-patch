import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import globals from "globals";

const tsFiles = [
  "cli/**/*.ts",
  "cli-capacitor/**/*.ts",
  "client/**/*.ts",
  "client-capacitor/**/*.ts",
  "server/**/*.ts",
  "shared/**/*.ts",
];

export default [
  {
    ignores: [
      "**/coverage/**",
      "**/dist/**",
      "**/node_modules/**",
      ".yarn/**",
      "client/android/**",
      "client/e2e/fixture-app/**",
      "client/ios/**",
      "client-capacitor/android/**",
      "client-capacitor/example-app/**",
      "client-capacitor/ios/**",
      "client-capacitor/native/**",
    ],
  },
  js.configs.recommended,
  {
    files: tsFiles,
    languageOptions: {
      ecmaVersion: "latest",
      parser: tsParser,
      parserOptions: {
        sourceType: "module",
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // The Capacitor SDK runs inside a WebView, so its sources (and the tests that
    // stub those APIs) see browser globals on top of the Node ones above.
    files: ["client-capacitor/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    // client-capacitor/src/protocol is the portable delivery-protocol layer shared in
    // spirit with client/src — it must stay free of Capacitor so it can be compared
    // against (and eventually merged with) the React Native client's copy. See
    // client-capacitor/specs/adr/0001-fork-protocol-layer-propose-patch-core.md.
    files: ["client-capacitor/src/protocol/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@capacitor/core",
              message:
                "src/protocol/ is the portable delivery-protocol layer and must not depend on Capacitor (see ADR-0001). Capacitor-specific code belongs in src/index.ts, src/web.ts, or the native platform folders.",
            },
          ],
          patterns: [
            {
              group: ["@capacitor/*"],
              message: "src/protocol/ must not depend on any @capacitor/* package (see ADR-0001).",
            },
          ],
        },
      ],
    },
  },
  {
    // React Native's bundler defines __DEV__; the SDK reads it for dev-only output.
    files: ["client/src/**/*.ts"],
    languageOptions: {
      globals: {
        __DEV__: "readonly",
      },
    },
  },
];
