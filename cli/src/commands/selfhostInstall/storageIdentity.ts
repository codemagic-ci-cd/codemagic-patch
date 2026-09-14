import type { CommandDeps } from "../shared";
import type { ParsedArgs } from "../selfhostSession";
import { askSelect } from "./ask";
import { supplied } from "./answers";
import { storageValue } from "./storageSetup";

export async function selectStorageIdentity(
  deps: CommandDeps,
  parsed: ParsedArgs,
  provider: "aws" | "gcloud",
): Promise<string> {
  const aws = provider === "aws";
  const flag = aws ? "--aws-profile" : "--gcp-account";
  const env = aws ? "AWS_PROFILE" : "CMPATCH_GCP_ACCOUNT";
  const message = aws
    ? "AWS profile to use for setup"
    : "gcloud account email to use for setup";
  const known = supplied(deps, parsed, { flag, env });
  if (known !== undefined) return known.value;

  let values: string[] = [];
  if (deps.prompt !== undefined) {
    try {
      let output = "";
      const result = await deps.runProcess({
        command: provider,
        args: aws
          ? ["configure", "list-profiles"]
          : ["auth", "list", "--format=value(account)", "--quiet"],
        env: { ...deps.env, AWS_PAGER: "" },
        onOutput: (chunk) => {
          output += chunk;
        },
      });
      if (result.exitCode === 0) {
        values = [
          ...new Set(
            output
              .split(/\r?\n/u)
              .map((s) => s.trim())
              .filter((s) =>
                aws ? /^[\w.@+-]+$/u.test(s) : /^[^\s@]+@[^\s@]+$/u.test(s),
              ),
          ),
        ];
      }
    } catch {
      // Discovery is optional; SDK profiles still work without the AWS CLI.
    }
  }
  if (values.length) {
    const selected = await askSelect(deps, {
      message,
      choices: [
        ...values.map((value) => ({ title: value, value })),
        { title: "Enter manually", value: "" },
      ],
      fallback: "",
    });
    if (values.includes(selected)) return selected;
  }
  return storageValue(
    deps,
    parsed,
    flag,
    env,
    message,
    aws ? "default" : undefined,
  );
}
