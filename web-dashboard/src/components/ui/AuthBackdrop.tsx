// Shared starfield chrome for the unauthenticated / mid-flow screens
// (login, callback, local-consent, CLI authorize). AUTH_CARD keeps a
// hairline so the panel stays distinct when surface matches canvas.

import type { ReactNode } from "react";

export const AUTH_CARD =
  "relative z-[2] w-full max-w-[430px] rounded-xl border border-border bg-surface p-[38px] text-center shadow-lg [animation:rise_.3s_ease_both]";

export function AuthBackdrop({ children }: { children: ReactNode }) {
  return (
    <div className="auth-art relative min-h-screen place-items-center overflow-hidden bg-[radial-gradient(120%_80%_at_50%_-10%,#0d122b,var(--color-canvas)_60%)] p-6 [display:grid]">
      <span
        className="absolute -left-[120px] -top-[180px] size-[560px] rounded-full bg-blue opacity-35 blur-[90px]"
        aria-hidden="true"
      />
      <span
        className="absolute -bottom-[220px] -right-[140px] size-[560px] rounded-full bg-magenta opacity-22 blur-[90px]"
        aria-hidden="true"
      />
      {children}
    </div>
  );
}
