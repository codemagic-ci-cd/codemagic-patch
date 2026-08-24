import type { ReleaseCreationWarning } from "../../../api/types";
import type { ToastApi } from "../../../components/overlay/ToastProvider";

/** One warning toast per non-blocking `warnings[]` entry on a release mutation response. */
export function toastReleaseWarnings(
  toast: ToastApi,
  warnings: ReleaseCreationWarning[] | undefined,
  approvedWarnings: ReadonlySet<string> = new Set(),
): void {
  for (const warning of warnings ?? []) {
    if (approvedWarnings.has(warning.code)) {
      continue;
    }
    toast.warning(
      warning.code === "fingerprint-disagreement"
        ? "Fingerprint disagreement"
        : "Release warning",
      { description: warning.detail },
    );
  }
}
