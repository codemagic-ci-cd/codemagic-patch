import {
  releaseFormPoliciesFromUploadPolicy,
  type ReleaseSafetyPolicy,
  type UploadPolicy,
} from "@codemagic/patch-shared";

import { HttpProblemError } from "../api/problem";

export type ReleasePublicationConflictKind =
  | "duplicate-release"
  | "fingerprint-disagreement";

export type ReleasePublicationConflict =
  | { kind: "duplicate-release" }
  | {
      kind: "fingerprint-disagreement";
      binaryVersion: string;
      releaseFingerprint: string;
      storedFingerprint: string;
    };

export interface ReleasePublicationFlowState {
  approvals: ReadonlySet<ReleasePublicationConflictKind>;
  conflict: ReleasePublicationConflict | null;
}

export type ReleasePublicationFlowAction =
  | { type: "uploadStarted" }
  | { type: "uploadSucceeded" }
  | { type: "uploadFailed" }
  | {
      type: "publicationConflictReceived";
      conflict: ReleasePublicationConflict;
    }
  | { type: "publicationConflictApproved" }
  | { type: "artifactChanged" }
  | { type: "reset" };

export function createReleasePublicationFlowState(): ReleasePublicationFlowState {
  return {
    approvals: new Set(),
    conflict: null,
  };
}

export function transitionReleasePublicationFlow(
  state: ReleasePublicationFlowState,
  action: ReleasePublicationFlowAction,
): ReleasePublicationFlowState {
  switch (action.type) {
    case "uploadStarted":
    case "uploadSucceeded":
      return { ...state, conflict: null };
    case "uploadFailed":
      return { ...state, conflict: null };
    case "publicationConflictReceived":
      return { ...state, conflict: action.conflict };
    case "publicationConflictApproved": {
      if (state.conflict === null) {
        return state;
      }
      const approvals = new Set(state.approvals);
      approvals.add(state.conflict.kind);
      return { approvals, conflict: null };
    }
    case "artifactChanged":
    case "reset":
      return createReleasePublicationFlowState();
  }
}

export function safetyPolicyForPublicationFlow(
  policy: UploadPolicy,
  state: ReleasePublicationFlowState,
): ReleaseSafetyPolicy {
  return releaseFormPoliciesFromUploadPolicy(
    {
      ...policy,
      noDuplicateReleaseError:
        policy.noDuplicateReleaseError ||
        state.approvals.has("duplicate-release"),
    },
    state.approvals.has("fingerprint-disagreement") ? "allow" : "block",
  ).safetyPolicy;
}

export function publicationConflictFromError(
  error: unknown,
): ReleasePublicationConflict | null {
  if (!(error instanceof HttpProblemError)) {
    return null;
  }
  if (error.typeSuffix === "duplicate-release") {
    return { kind: "duplicate-release" };
  }
  if (error.typeSuffix !== "fingerprint-disagreement") {
    return null;
  }

  const { binary_version, release_fingerprint, stored_fingerprint } =
    error.extensions;
  return typeof binary_version === "string" &&
    typeof release_fingerprint === "string" &&
    typeof stored_fingerprint === "string"
    ? {
        kind: "fingerprint-disagreement",
        binaryVersion: binary_version,
        releaseFingerprint: release_fingerprint,
        storedFingerprint: stored_fingerprint,
      }
    : null;
}
