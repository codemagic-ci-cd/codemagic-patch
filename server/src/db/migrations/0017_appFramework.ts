import type { SqlMigration } from "./index";

/**
 * Which framework an app is built with, so a client that shows
 * framework-specific guidance can tell. The server stores and returns it and
 * never branches on it.
 *
 * No CHECK on the value: a CLI for a framework that does not exist yet has to
 * be able to label its apps on a server installed before it existed. Every app
 * created before this column is React Native, which is what the default says.
 */
export const appFrameworkMigration: SqlMigration = {
  name: "0017_app_framework",
  sql: `
    ALTER TABLE app
      ADD COLUMN framework TEXT NOT NULL DEFAULT 'react-native';
  `,
};
