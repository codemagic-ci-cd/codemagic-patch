// Shared lifecycle-action coordinator. Both action-handoff
// points — DeploymentDetailPage's `onAction(type, release)` (release null =
// deployment-level rollback) and ReleaseDetailPage's `onAction(action,
// release)` — swap their no-op for `openAction` and render `modals`, keeping
// each page a two-line change. The hook owns WHICH modal is open + its
// target snapshot; the five modals stay unmounted while closed (each one
// early-returns null), so their form/mutation state resets per open and
// their data hooks (deployments / releases queries) never run idle. Action
// unions on the pages are subsets of ReleaseLifecycleAction, so the pages'
// existing handler signatures accept `openAction` unchanged.

import { useState } from "react";
import type { ReactNode } from "react";

import { EditMetadataModal } from "./EditMetadataModal";
import { PromoteModal } from "./PromoteModal";
import { RollbackModal } from "./RollbackModal";
import { RolloutModal } from "./RolloutModal";
import { StatusModal } from "./StatusModal";
import type { Release } from "../../../model/release";

/** Superset of both pages' action unions (handoff shapes). */
export type ReleaseLifecycleAction =
  | "patch-rollout"
  | "promote"
  | "disable"
  | "enable"
  | "rollback"
  | "edit-metadata";

export interface UseReleaseActionsOptions {
  teamId: string;
  appId: string;
  /** Deployment scoping the rollback + the promote conflict deep-links. */
  deploymentId: string;
  /** Display name for the rollback title/toast (unknown on release detail). */
  deploymentName?: string;
}

export interface ReleaseActions {
  /** Single swap-in for the pages' `onAction` no-ops. */
  openAction: (action: ReleaseLifecycleAction, release: Release | null) => void;
  /** Render once anywhere in the page tree (modals portal to body). */
  modals: ReactNode;
}

export function useReleaseActions({
  teamId,
  appId,
  deploymentId,
  deploymentName,
}: UseReleaseActionsOptions): ReleaseActions {
  const [pending, setPending] = useState<{
    action: ReleaseLifecycleAction;
    /** Snapshot of the target row at open time; null for rollback. */
    release: Release | null;
  } | null>(null);

  const close = () => setPending(null);

  const modals = (
    <>
      <RolloutModal
        release={
          pending?.action === "patch-rollout" ? pending.release : null
        }
        onClose={close}
      />
      <StatusModal
        release={
          pending !== null &&
          (pending.action === "disable" || pending.action === "enable")
            ? pending.release
            : null
        }
        onClose={close}
      />
      <PromoteModal
        release={pending?.action === "promote" ? pending.release : null}
        teamId={teamId}
        appId={appId}
        onClose={close}
      />
      <RollbackModal
        open={pending?.action === "rollback"}
        deploymentId={deploymentId}
        deploymentName={deploymentName}
        onClose={close}
      />
      <EditMetadataModal
        release={
          pending?.action === "edit-metadata" ? pending.release : null
        }
        onClose={close}
      />
    </>
  );

  return {
    openAction: (action, release) => setPending({ action, release }),
    modals,
  };
}
