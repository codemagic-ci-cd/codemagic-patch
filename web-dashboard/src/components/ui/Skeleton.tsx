// Loading shimmer block.
// The `.skel` rules ported to utility literals. The shimmer
// is a pure CSS animation, and base.css globally disables all animations under
// `prefers-reduced-motion: reduce`, so the block degrades to a static tint.
// Skeletons are decorative (aria-hidden) — the loading REGION owns the
// status semantics (e.g. a `role="status"` wrapper on the screen).

import { clsx } from "clsx";
import type { CSSProperties } from "react";

const SKELETON =
  "animate-shimmer rounded-[7px] bg-[linear-gradient(100deg,var(--color-surface-3)_30%,var(--color-surface-2)_50%,var(--color-surface-3)_70%)] bg-[length:200%_100%]";

// Legacy `.skel-line` / `.skel-text` presets.
const SKELETON_VARIANT = {
  line: "my-[7px] h-3",
  text: "h-[13px]",
} as const;

export interface SkeletonProps {
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  /** Size preset; `width`/`height` (inline styles) win over it when both set. */
  variant?: keyof typeof SKELETON_VARIANT;
  /** Extra LAYOUT classes only (margins, grid placement). */
  className?: string;
}

export function Skeleton({ width, height, variant, className }: SkeletonProps) {
  return (
    <div
      className={clsx(
        SKELETON,
        variant !== undefined && SKELETON_VARIANT[variant],
        className,
      )}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}
