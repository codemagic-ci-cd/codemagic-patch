// Team-level GitHub PAT configuration for workflow dispatch.

import { useState, type FormEvent } from "react";

import {
  useRevokeTeamGitHubIntegration,
  useTeamGitHubIntegration,
  useUpsertTeamGitHubIntegration,
} from "../../api/hooks/githubActions";
import { useTeams } from "../../api/hooks/teams";
import { HttpProblemError } from "../../api/problem";
import { readLastTeamId } from "../shell/lastTeam";
import { resolveHomeTeamId } from "../shell/teamResolution";
import { useToast } from "../overlay/ToastProvider";
import { buttonVariants } from "../ui/Button";
import { CALLOUT, CALLOUT_TONE } from "../ui/callout";
import { FIELD, FIELD_HINT, FIELD_LABEL, INPUT, INPUT_STATE } from "../ui/form";
import { Skeleton } from "../ui/Skeleton";

export function GitHubTeamIntegrationCard() {
  const toast = useToast();
  const teamsQuery = useTeams();
  const teamId =
    teamsQuery.data !== undefined
      ? (resolveHomeTeamId(teamsQuery.data, readLastTeamId() ?? "") ?? "")
      : "";

  const integrationQuery = useTeamGitHubIntegration(teamId);
  const upsert = useUpsertTeamGitHubIntegration(teamId);
  const revoke = useRevokeTeamGitHubIntegration(teamId);
  const [token, setToken] = useState("");

  const handleSave = (event: FormEvent) => {
    event.preventDefault();
    upsert.mutate(
      { token: token.trim() },
      {
        onSuccess: () => {
          setToken("");
          toast.success("GitHub PAT saved", {
            description: "Patch can now dispatch workflows for this team.",
          });
        },
        onError: (error) => {
          toast.error("Could not save PAT", {
            description:
              error instanceof HttpProblemError
                ? error.detail
                : "Try again.",
          });
        },
      },
    );
  };

  const handleRevoke = () => {
    revoke.mutate(undefined, {
      onSuccess: () => {
        toast.success("GitHub PAT removed");
      },
      onError: (error) => {
        toast.error("Could not revoke PAT", {
          description:
            error instanceof HttpProblemError
              ? error.detail
              : "Try again.",
        });
      },
    });
  };

  return (
    <div className="mt-[22px] rounded-lg border border-border bg-surface p-[22px] shadow-sm">
      <h2 className="text-[17px] font-bold">GitHub Actions integration</h2>
      <p className="mt-1.5 max-w-[62ch] text-[14px] text-fg-2">
        Fine-grained personal access token with <b>Actions: Read and write</b>{" "}
        on your release repo. Patch uses it to trigger{" "}
        <code className="text-fg">workflow_dispatch</code> from the dashboard.
      </p>

      <div className={`${CALLOUT} ${CALLOUT_TONE.info} mt-4`}>
        <div>
          This is separate from Patch API tokens above. GitHub secrets in your
          repo still need <code>CODEMAGIC_PATCH_TOKEN</code> so CI can upload
          releases.
        </div>
      </div>

      {teamsQuery.isPending || integrationQuery.isPending ? (
        <div className="mt-4" role="status">
          <Skeleton variant="line" />
        </div>
      ) : teamId.length === 0 ? (
        <p className="mt-4 text-[13px] text-fg-2">No team available.</p>
      ) : integrationQuery.data?.configured ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="text-[14px] text-fg">
            Connected · token ending in{" "}
            <code>{integrationQuery.data.tokenLast4}</code>
          </span>
          <button
            type="button"
            className={buttonVariants({ intent: "ghost", size: "sm" })}
            disabled={revoke.isPending}
            onClick={handleRevoke}
          >
            Revoke
          </button>
        </div>
      ) : (
        <form className="mt-4 flex flex-col gap-3" onSubmit={handleSave}>
          <label className={FIELD}>
            <span className={FIELD_LABEL}>GitHub personal access token</span>
            <input
              type="password"
              autoComplete="off"
              className={`${INPUT} ${INPUT_STATE.normal}`}
              value={token}
              required
              onChange={(event) => setToken(event.target.value)}
            />
            <span className={FIELD_HINT}>
              Stored encrypted on the server; never shown again after save.
            </span>
          </label>
          <div>
            <button
              type="submit"
              className={buttonVariants({ intent: "primary", size: "sm" })}
              disabled={upsert.isPending || token.trim().length < 10}
            >
              Save GitHub PAT
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
