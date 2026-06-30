// Button primitive (Tailwind migration). The variant strings are a 1:1 port
// of the legacy `.btn*` rules — visual parity is pinned by the e2e screenshot
// suite, so edits here must pass the zero-diff gate.
//
// Two intentional consumption forms:
//   <Button intent="primary">            — components / refactored call sites
//   className={buttonVariants({ … })}    — raw <button> / <Link> elements
//
// No tailwind-merge on purpose: variants that can co-occur never set the same
// CSS property (size owns ALL of padding/text/radius/gap/svg sizing — base and
// intents never touch those), and callers may only append LAYOUT classes
// (margins, grid placement) — restyling button internals from a call site is
// out of contract.
import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import type { ButtonHTMLAttributes } from "react";

export const buttonVariants = cva(
  [
    "inline-flex items-center justify-center whitespace-nowrap",
    // border-COLOR lives on each intent (not here): two co-applied classes
    // must never set the same property — see the no-merge contract above.
    "border font-semibold tracking-[-.01em]",
    "[transition:.16s]",
    "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
  ],
  {
    variants: {
      intent: {
        primary: [
          "border-transparent bg-[linear-gradient(180deg,var(--color-blue),var(--color-blue-deep))] text-white",
          "shadow-[0_6px_16px_-6px_rgba(0,81,255,.6)]",
          "hover:brightness-[1.06] hover:shadow-[0_8px_22px_-6px_rgba(0,81,255,.7),var(--shadow-glow)]",
          "active:translate-y-px",
        ],
        ghost:
          "border-border-strong bg-surface text-fg hover:border-blue hover:text-blue hover:shadow-xs",
        subtle:
          "border-transparent bg-surface-2 text-fg-2 hover:bg-surface-3 hover:text-fg",
        danger: [
          "border-transparent bg-red text-white shadow-[0_6px_16px_-6px_rgba(236,12,67,.55)]",
          "hover:brightness-[1.05] hover:shadow-[0_8px_22px_-6px_rgba(236,12,67,.6)]",
        ],
        dangerGhost: "border-transparent bg-red-tint text-red hover:bg-[#fbd3dd]",
        gh: "border-[#1b1f2e] bg-[#1b1f2e] text-white hover:bg-black hover:shadow-md",
      },
      size: {
        // No explicit leading here ON PURPOSE: <button> does not inherit the
        // body line-height — it uses the UA's `line-height: normal`, and the
        // legacy .btn sizing was built on that (e.g. 15px text → 44px button).
        md: "gap-2 rounded-control px-[15px] py-[9px] text-[13.5px] [&_svg]:size-4",
        sm: "gap-1.5 rounded-sm px-[11px] py-1.5 text-[12.5px] [&_svg]:size-3.5",
        lg: "gap-2 rounded-md px-[22px] py-[13px] text-[15px] [&_svg]:size-4",
      },
      block: {
        true: "w-full",
      },
    },
    defaultVariants: {
      intent: "primary",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({
  intent,
  size,
  block,
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={clsx(buttonVariants({ intent, size, block }), className)}
      {...props}
    />
  );
}
