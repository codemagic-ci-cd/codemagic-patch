import type { SqlMigration } from "./index";

export const phase6ManagementCrudPermissionsMigration: SqlMigration = {
  name: "0007_phase6_management_crud_permissions",
  sql: `
    INSERT INTO role_permission (role_definition_id, action)
    VALUES
      ('role_admin', 'app.manage'),
      ('role_owner', 'app.manage')
    ON CONFLICT (role_definition_id, action) DO NOTHING;
  `,
};
