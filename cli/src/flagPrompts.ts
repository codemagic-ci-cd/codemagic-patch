// Prompt primitives shared by `init` and the interactive resolution of missing
// required flags. Both ask the same questions about the same things, so they
// must ask them the same way — the wording and the shape of every choice list
// live here rather than in either caller.

import { authenticatedRequest } from "./authenticatedRequest";
import {
  assertHttpUrl,
  buildApiUrl,
  buildApiUrlWithQuery,
  UsageError,
  ValidationError,
  type CommandDeps,
} from "./commands/shared";
import { isRecord, writeLine } from "./output";
import type { PromptFn } from "./prompt";

export type NamedResource = {
  id: string;
  name: string;
};

export type ResourceLabel = "app" | "deployment" | "team";

/**
 * Re-asked rather than rejected: a URL typed without its scheme used to end
 * the run with the same message this now prints above the next question, and
 * the mistyped value stays in the field so the fix is an edit, not a retype.
 * A non-empty answer always comes back passing `assertHttpUrl`, which callers
 * still apply to flag and environment values that never went through a prompt.
 *
 * An empty answer is handed back as it is, not re-asked: the prompt layer
 * refuses one before it gets here, so an empty answer only ever comes from a
 * caller's own prompt double, and the flag resolver's contract is that an
 * answer which does not unblock its parse ends the round rather than looping.
 */
export async function promptServerUrl(
  deps: Pick<CommandDeps, "stderr">,
  prompt: PromptFn,
  initial: string | undefined,
): Promise<string> {
  for (;;) {
    const value = String(
      await prompt({ initial, message: "Server URL", type: "text" }),
    ).trim();
    if (value.length === 0) {
      return value;
    }

    try {
      return assertHttpUrl(value);
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        throw error;
      }

      if (deps.stderr !== undefined) {
        writeLine(deps.stderr, error.message);
      }
      initial = value;
    }
  }
}

export async function promptResource(
  prompt: PromptFn,
  message: string,
  resources: NamedResource[],
  label: ResourceLabel,
): Promise<NamedResource> {
  if (resources.length === 0) {
    throw new UsageError(`No ${label}s are available. Create one first.`);
  }

  const value = await prompt({
    choices: resources.map((resource) => ({
      title: resource.name,
      value: resource.id,
    })),
    message,
    type: "select",
  });
  const selectedId = Array.isArray(value) ? value[0] : value;
  const chosen = resources.find((resource) => resource.id === selectedId);
  if (chosen === undefined) {
    throw new UsageError(`Invalid ${label} selection.`);
  }

  return chosen;
}

/**
 * Not an id any server issues, so it cannot collide with a real selection.
 */
const CREATE_NEW = "__create_new__";

/**
 * The same picker, plus a way out of it: choose an existing resource, or say
 * that none of them is the one and it should be created.
 *
 * Offered where a list that is missing what the user needs would otherwise be
 * a dead end they can only leave by running another command — a team that
 * holds another project's apps, or one where a previous run created some of
 * this project's and stopped.
 */
export async function promptResourceOrCreate(
  prompt: PromptFn,
  message: string,
  resources: NamedResource[],
  label: ResourceLabel,
  createTitle: string,
): Promise<NamedResource | "create"> {
  const value = await prompt({
    choices: [
      ...resources.map((resource) => ({
        title: resource.name,
        value: resource.id,
      })),
      { title: createTitle, value: CREATE_NEW },
    ],
    message,
    type: "select",
  });

  const selectedId = Array.isArray(value) ? value[0] : value;
  if (selectedId === CREATE_NEW) {
    return "create";
  }

  const chosen = resources.find((resource) => resource.id === selectedId);
  if (chosen === undefined) {
    throw new UsageError(`Invalid ${label} selection.`);
  }

  return chosen;
}

/**
 * A name for something about to be created. Free text, so unlike the selects
 * there is nothing to constrain it to — the parser still validates what comes
 * back, and an unusable answer ends the round rather than looping.
 */
export async function promptName(
  prompt: PromptFn,
  noun: string,
  initial?: string,
): Promise<string> {
  const value = await prompt({
    ...(initial !== undefined ? { initial } : {}),
    message: `Name for the new ${noun}`,
    type: "text",
  });

  return String(value).trim();
}

/** Free text the user has to supply, with the flag it stands for as the ask. */
export async function promptValue(
  prompt: PromptFn,
  message: string,
): Promise<string> {
  const value = await prompt({ message, type: "text" });

  return String(value).trim();
}

/** One of a fixed set — a role, a yes/no setting. */
export async function promptChoice(
  prompt: PromptFn,
  message: string,
  choices: readonly string[],
): Promise<string> {
  const value = await prompt({
    choices: choices.map((choice) => ({ title: choice, value: choice })),
    message,
    type: "select",
  });

  return Array.isArray(value) ? (value[0] ?? "") : value;
}

export const TEAM_ROLES = ["viewer", "developer", "admin", "owner"] as const;

/**
 * Release labels live on the server and nobody memorises them, so the list is
 * fetched rather than typed. Newest first: a rollback or a promote is almost
 * always about something recent.
 */
const RELEASE_LABEL_PAGE_SIZE = 100;

export async function listReleaseLabels(
  deps: CommandDeps,
  serverUrl: string,
  deploymentId: string,
  token: string | undefined,
): Promise<string[]> {
  const labels: string[] = [];
  let rows = 0;
  let offset = 0;

  // The server pages this listing, and execution's release resolver walks
  // every page — a picker that stopped at the first page would silently hide
  // the very release the user came to promote or roll back to.
  while (true) {
    const response = await authenticatedRequest(deps, {
      init: { method: "GET" },
      serverUrl,
      token,
      url: buildApiUrlWithQuery(
        serverUrl,
        "/v1/deployments/" + encodeURIComponent(deploymentId) + "/releases",
        { limit: RELEASE_LABEL_PAGE_SIZE, offset },
      ),
    });

    if (!isRecord(response) || !Array.isArray(response.releases)) {
      throw new UsageError("Malformed releases response");
    }

    // Each entry nests the release under its own key, the same shape
    // `release list` renders from. Reading the label off the wrapper yields
    // undefined for every row, which is indistinguishable from an empty
    // deployment unless it is caught here.
    rows += response.releases.length;
    labels.push(
      ...response.releases
        .filter(isRecord)
        .map((entry) =>
          isRecord(entry.release) ? entry.release.release_label : undefined,
        )
        .filter((label): label is string => typeof label === "string"),
    );

    // A server that does not page (no well-formed pagination block) has sent
    // everything it has; otherwise walk forward until the total is covered,
    // refusing to loop on a page that fails to advance.
    const pagination = isRecord(response.pagination)
      ? response.pagination
      : undefined;
    if (
      pagination === undefined ||
      typeof pagination.limit !== "number" ||
      typeof pagination.offset !== "number" ||
      typeof pagination.total !== "number"
    ) {
      break;
    }

    const nextOffset = pagination.offset + pagination.limit;
    if (nextOffset >= pagination.total || nextOffset <= offset) {
      break;
    }
    offset = nextOffset;
  }

  if (labels.length === 0 && rows > 0) {
    throw new UsageError(
      "Could not read release labels from the server response. Pass --label explicitly.",
    );
  }

  return labels;
}

export async function promptBundler(
  prompt: PromptFn,
  detected: "expo" | "metro",
): Promise<"expo" | "metro"> {
  const value = await prompt({
    choices: [
      { title: "metro", value: "metro" },
      { title: "expo", value: "expo" },
    ],
    initial: detected === "expo" ? 1 : 0,
    message: "Select bundler",
    type: "select",
  });

  return value === "expo" ? "expo" : "metro";
}

/**
 * Single-platform variant of the multiselect `init` uses: release-react and
 * bundle each publish for exactly one platform, so offering a checkbox list
 * would let the user pick a combination the command cannot honour.
 */
export async function promptPlatform(
  prompt: PromptFn,
  detected: Array<"android" | "ios">,
): Promise<"android" | "ios"> {
  const ordered: Array<"android" | "ios"> =
    detected.length > 0 ? detected : ["ios", "android"];
  const value = await prompt({
    choices: ordered.map((platform) => ({ title: platform, value: platform })),
    message: "Select platform",
    type: "select",
  });

  return value === "android" ? "android" : "ios";
}

export async function listNamedResources(
  deps: CommandDeps,
  serverUrl: string,
  pathname: string,
  token: string | undefined,
  wrapperKey: "apps" | "deployments" | "teams",
): Promise<NamedResource[]> {
  const response = await authenticatedRequest(deps, {
    init: { method: "GET" },
    serverUrl,
    token,
    url: buildApiUrl(serverUrl, pathname),
  });

  if (!isRecord(response) || !Array.isArray(response[wrapperKey])) {
    throw new UsageError(`Malformed ${wrapperKey} response`);
  }

  return response[wrapperKey].map((resource) => {
    if (
      !isRecord(resource) ||
      typeof resource.id !== "string" ||
      typeof resource.name !== "string"
    ) {
      throw new UsageError(`Malformed ${wrapperKey} response`);
    }

    return { id: resource.id, name: resource.name };
  });
}
