import type { ReleaseCreationWarning } from "../../../api/types";
import type { ToastApi } from "../../../components/overlay/ToastProvider";

/** One warning toast per non-blocking `warnings[]` entry on a release mutation response. */
export function toastReleaseWarnings(
  toast: ToastApi,
  warnings: ReleaseCreationWarning[] | undefined,
): void {
  for (const warning of warnings ?? []) {
    toast.warning(
      warning.code === "fingerprint-disagreement"
        ? "Fingerprint disagreement"
        : "Release warning",
      { description: warning.detail },
    );
  }
}
