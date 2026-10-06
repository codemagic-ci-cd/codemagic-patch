// The framework of the apps this CLI publishes for.
//
// A client always knows which framework it releases for, and a client that has
// to show framework-specific guidance — the dashboard — has no other way to
// know: so `app create` states it. The server stores the value and compares it
// when a list asks it to, and never reads anything into it.
//
// Every request for a team's apps asks for this framework's (`?framework=`):
// `app list`, the lookup of an app named with `--app`, the interactive pickers,
// `init` and `doctor`. So this CLI sees one kind of app throughout, and another
// framework's app cannot be published to by name, by mistake. Nothing checks an
// app reached by its id (`--app-id`, `--deployment-id`): that is deliberate.
//
// A server that predates the parameter ignores it and lists every app — all of
// which, on such a server, are this framework's.

export const APP_FRAMEWORK = "react-native";

/** The path of a team's app list, as this CLI asks for it. */
export function teamAppsPath(teamId: string): string {
  return `/v1/teams/${encodeURIComponent(teamId)}/apps?framework=${encodeURIComponent(APP_FRAMEWORK)}`;
}
