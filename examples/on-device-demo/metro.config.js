const {getDefaultConfig} = require('@react-native/metro-config');

/**
 * Standalone Metro config — this example app is intentionally NOT part of the
 * monorepo workspaces, so the React Native CLI defaults are all it needs.
 */
module.exports = getDefaultConfig(__dirname);
