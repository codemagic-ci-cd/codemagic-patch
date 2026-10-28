/** Vitest config plugin that points `@codemagic/react-native-patch` at its TypeScript source. */
export declare function codemagicPatch(): {
  name: string;
  config(): {
    resolve: { alias: { find: RegExp; replacement: string }[] };
  };
};
