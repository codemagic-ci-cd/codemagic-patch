// What this CLI's apps are built with. The server stores the value, compares it when a
// list asks it to, and reads nothing into it; the dashboard words its guidance by it —
// which CLI's command to show for a release.
//
// `app create` sends it without a flag or a question: a CLI knows which framework it is
// for. And every request for a team's apps asks for this framework's (`?framework=`):
// `app list`, and the lookup of an app named with --app. So this CLI sees one kind of app
// throughout, and another framework's app cannot be published to by name, by mistake.
// Nothing checks an app reached by its id (--app-id, --deployment-id): that is deliberate
// (decided 2026-09-22). See cli-capacitor-tech-spec › R34.

export const APP_FRAMEWORK = "capacitor";

/** The path of a team's app list, as this CLI asks for it. */
export function teamAppsPath(teamId: string): string {
  return `/v1/teams/${encodeURIComponent(teamId)}/apps?framework=${encodeURIComponent(APP_FRAMEWORK)}`;
}
