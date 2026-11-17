/**
 * "How did you hear about us?": one optional question after a first install,
 * asked once per machine and sent apart from the server's usage report.
 * Contract: specs/telemetry/install-survey-v1.md.
 */

import { PRODUCT_NAME } from "../../branding";
import { loadCliConfig, saveCliConfig } from "../../configStore";
import { type SelectChoice } from "../../prompt";
import { getCliVersion } from "../../version";
import { paletteFor } from "../selfhostSession";
import { type CommandDeps } from "../shared";

export const INSTALL_SURVEY_ENDPOINT =
  "https://telemetry.codemagicpatch.dev/v1/install-survey";
export const INSTALL_SURVEY_QUESTION = `How did you hear about ${PRODUCT_NAME}?`;
export const OTHER_TEXT_MAX_CHARACTERS = 200;
const SEND_TIMEOUT_MS = 3_000;

const SKIP = "skip";
const ANSWERS = [
  { title: "AI Assistant (ChatGPT, Claude, Perplexity)", value: "ai-assistant" },
  { title: "Search Engine (Google, Bing, DuckDuckGo)", value: "search-engine" },
  {
    title: "Colleague, Community, or Docs (Recommendation, Reddit, Framework docs)",
    value: "colleague-community-docs",
  },
  {
    title: "Events, Outreach, or Ads (Conferences, Email, Sponsored Posts)",
    value: "events-outreach-ads",
  },
  { title: "Other", value: "other" },
] as const satisfies readonly SelectChoice[];

export type InstallSurveyInstall = "fly" | "ngrok" | "ssh";

/** `$defs/strictAnswer` of shared/schemas/install-survey.v1.schema.json. */
export type InstallSurveyAnswer = {
  answer: (typeof ANSWERS)[number]["value"];
  install: InstallSurveyInstall;
  other_text?: string;
  schema_version: 1;
};

export type InstallSurveyInput = {
  install: InstallSurveyInstall;
  /** Whether this run may ask questions at all (`canAsk`). */
  interactive: boolean;
  /** `--no-telemetry`: it turns the question off together with the usage report. */
  noTelemetry: boolean;
};

/**
 * Asks, and sends the answer if there is one. Call it only where a first
 * install has just succeeded, before the closing summary.
 *
 * Nothing here can change the install's outcome: Ctrl+C on the question, a
 * config file that cannot be written, and a collector that is unreachable all
 * end the same way, silently, with the install still a success.
 *
 * It returns once the question is answered, not once the answer is sent, so
 * the summary never waits on the collector. The request in flight keeps the
 * process alive until it settles, for its timeout at most.
 */
export async function askInstallSurvey(
  deps: CommandDeps,
  input: InstallSurveyInput,
): Promise<void> {
  try {
    const answer = await collectAnswer(deps, input);
    if (answer !== null) {
      void sendAnswer(deps, answer).catch(() => {});
    }
  } catch {
    // See above: every failure is a skip.
  }
}

async function collectAnswer(
  deps: CommandDeps,
  input: InstallSurveyInput,
): Promise<InstallSurveyAnswer | null> {
  const prompt = deps.prompt;
  if (
    !input.interactive ||
    prompt === undefined ||
    input.noTelemetry ||
    doNotTrack(deps.env)
  ) {
    return null;
  }

  const config = await loadCliConfig({ env: deps.env });
  if (config.installSurveyAskedAt !== undefined) {
    return null;
  }
  // Recorded before the question is drawn, so that it is asked once per
  // machine whatever happens to this one: answered, skipped, or interrupted.
  await saveCliConfig(
    { ...config, installSurveyAskedAt: new Date(deps.now()).toISOString() },
    { env: deps.env },
  );

  const { dim } = paletteFor(deps);
  const chosen = await prompt({
    choices: [{ title: "Skip", value: SKIP }, ...ANSWERS],
    // Two short lines: one long one wraps mid-sentence in an 80-column terminal.
    message: [
      INSTALL_SURVEY_QUESTION,
      dim(`Optional. Sends your choice and the install method (${input.install}).`),
      dim("Other also sends the text as typed."),
    ].join("\n"),
    type: "select",
  });
  const answer = ANSWERS.find((candidate) => candidate.value === chosen)?.value;
  if (answer === undefined) {
    return null;
  }
  if (answer !== "other") {
    return { answer, install: input.install, schema_version: 1 };
  }

  const typed = await prompt({
    message: `Where did you hear about it? Optional, ${OTHER_TEXT_MAX_CHARACTERS} characters at most.`,
    optional: true,
    type: "text",
  });
  // Counted in code points, as the collector's schema counts them.
  const text = Array.from(typeof typed === "string" ? typed.trim() : "")
    .slice(0, OTHER_TEXT_MAX_CHARACTERS)
    .join("");
  return {
    answer,
    install: input.install,
    ...(text.length > 0 ? { other_text: text } : {}),
    schema_version: 1,
  };
}

/** One attempt. The collector's answer is not read: no status changes anything here. */
async function sendAnswer(
  deps: CommandDeps,
  answer: InstallSurveyAnswer,
): Promise<void> {
  const response = await deps.fetch(INSTALL_SURVEY_ENDPOINT, {
    body: JSON.stringify(answer),
    headers: {
      "content-type": "application/json",
      "user-agent": `cmpatch/${getCliVersion()}`,
    },
    method: "POST",
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  await response.body?.cancel();
}

/** The server's own rule for `DO_NOT_TRACK`: `1` or `true`, trimmed, any case. */
function doNotTrack(env: Record<string, string | undefined>): boolean {
  const value = (env.DO_NOT_TRACK ?? "").trim().toLowerCase();
  return value === "1" || value === "true";
}
