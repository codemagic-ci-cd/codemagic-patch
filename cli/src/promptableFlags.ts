// The one description of every flag the CLI can obtain by asking.
//
// Three separate stages need the same facts about these flags — the parser, to
// name what is missing; the defaults stage, to notice it is missing; and the
// resolver, to ask for it and to echo the equivalent command line. They used to
// keep private copies, which is how the resolver ended up understanding only
// half the flag syntax the parser accepts. Nothing here may import prompt or
// UI code: the parser is pure and must stay that way.

import { hasOption } from "./argv";
import type { PromptableFlag } from "./commandTypes";

export type PromptableFlagIdentity = {
  /**
   * The flag parses as a boolean, so a replayed value must be spelled
   * `--flag=value`: the parser reads a bare `--flag` as true and would reject
   * a following `false` token as a stray positional.
   */
  boolean?: true;
  /** The name used in "Missing required flag --<label>". */
  label: string;
  /** Every spelling that supplies this flag, including id-shaped aliases. */
  options: string[];
};

/**
 * Declaration order is resolution order, and the order matters: apps belong to
 * a team and deployments belong to an app, so the server URL has to be known
 * before any of them can be listed.
 */
export const PROMPTABLE_FLAGS: Record<PromptableFlag, PromptableFlagIdentity> = {
  name: { label: "name", options: ["--name"] },
  newName: { label: "new-name", options: ["--new-name"] },
  bundlePath: { label: "bundle-path", options: ["--bundle-path"] },
  email: { label: "email", options: ["--email", "--user-id"] },
  githubHandle: { label: "github-handle", options: ["--github-handle"] },
  role: { label: "role", options: ["--role"] },
  fromRole: { label: "from-role", options: ["--from-role"] },
  requireCodeSigning: {
    boolean: true,
    label: "require-code-signing",
    options: ["--require-code-signing"],
  },
  serverUrl: { label: "server-url", options: ["--server-url"] },
  team: { label: "team", options: ["--team", "--team-id"] },
  app: { label: "app", options: ["--app", "--app-id"] },
  deployment: {
    label: "deployment",
    options: ["--deployment", "--deployment-id"],
  },
  // Listing releases needs the deployment resolved first, so this stays last
  // of the server-side selectors.
  // Promote scopes its two ends with their own flags, so neither can be filled
  // by --deployment. No list is reachable for them, which is a reason to ask
  // plainly — not a reason to refuse and print usage.
  sourceDeployment: {
    label: "source-deployment",
    options: ["--source-deployment", "--source-deployment-id"],
  },
  destDeployment: {
    label: "dest-deployment",
    options: ["--dest-deployment", "--dest-deployment-id"],
  },
  label: { label: "label", options: ["--label"] },
  platform: { label: "platform", options: ["--platform"] },
  bundler: { label: "bundler", options: ["--bundler"] },
};

/**
 * The subset that stored configuration can also supply — the key set of
 * CommandDefaultPolicy. The rest are prompt-only: a name for something being
 * created, a role, a release label, an email address. Nothing remembers those
 * for the user, which is exactly why asking is the only way to get them.
 */
export const CONFIG_DEFAULTED_FLAGS: readonly PromptableFlag[] = [
  "app",
  "bundler",
  "deployment",
  "platform",
  "serverUrl",
  "team",
];

export const PROMPTABLE_FLAG_ORDER = Object.keys(
  PROMPTABLE_FLAGS,
) as PromptableFlag[];

/** The flag a "Missing required flag --x" message is about, if it is one. */
export function promptableFlagForLabel(
  label: string,
): PromptableFlag | undefined {
  return PROMPTABLE_FLAG_ORDER.find(
    (flag) => PROMPTABLE_FLAGS[flag].label === label,
  );
}

/** The primary spelling, for showing the user what they could have typed. */
export function primaryOptionFor(flag: PromptableFlag): string {
  return PROMPTABLE_FLAGS[flag].options[0] ?? `--${flag}`;
}

/**
 * The argv tokens that would supply this flag with this value, in a form the
 * parser actually accepts — the registry knows which flags must use the
 * `--flag=value` spelling, so callers cannot render an unrunnable pair.
 */
export function formatFlagAssignment(
  flag: PromptableFlag,
  value: string,
): string[] {
  const option = primaryOptionFor(flag);

  return PROMPTABLE_FLAGS[flag].boolean === true
    ? [`${option}=${value}`]
    : [option, value];
}

/** Whether any spelling of this flag appears in argv, in either value form. */
export function hasFlagOption(argv: string[], flag: PromptableFlag): boolean {
  return PROMPTABLE_FLAGS[flag].options.some((option) =>
    hasOption(argv, option),
  );
}
