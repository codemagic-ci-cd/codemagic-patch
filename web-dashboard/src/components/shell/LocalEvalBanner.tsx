// Persistent local-evaluation banner (HOST-NEW-01 lesson: a convenience
// default must be loudly visible, not discoverable). Renders a slim,
// non-dismissable strip above the app-shell grid whenever the signed-in
// account came from the local evaluation stack's fake identity provider;
// renders nothing for GitHub-provider sessions or while whoami is
// loading/failed — the banner is advisory chrome, never a gate.
//
// Height contract: exactly EVAL_BANNER_HEIGHT_PX (single line, truncated on
// overflow; height and line-height are driven from the constant below).
// AppShell reserves the same value as `--eval-banner-h` so the TopBar and
// Sidebar sticky offsets clear the banner instead of sliding underneath it
// on scroll.

import { useIsLocalDevSession } from "../../api/hooks/me";

/** Kept in sync with AppShell's `--eval-banner-h` reservation. */
export const EVAL_BANNER_HEIGHT_PX = 34;

export function LocalEvalBanner() {
  const localDev = useIsLocalDevSession();

  if (!localDev) {
    return null;
  }

  return (
    <div
      className="sticky top-0 z-50 truncate bg-yellow-tint px-4 text-center text-[12.5px] font-semibold text-[#8a5414]"
      role="status"
      style={{
        height: EVAL_BANNER_HEIGHT_PX,
        lineHeight: `${EVAL_BANNER_HEIGHT_PX}px`,
      }}
    >
      Local evaluation mode — authentication is disabled. Do not expose this
      deployment.
    </div>
  );
}
