// Button primitive (Tailwind migration). Ghost/subtle/danger stay a port of
// the legacy `.btn*` rules. Primary consumes the dashboard action role rather
// than choosing a Codemagic blue swatch directly.
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
          "border-transparent bg-action-primary text-white",
          "hover:bg-action-primary-hover",
          "active:scale-[0.97]",
        ],
        ghost:
          "border-border-strong bg-surface text-fg hover:border-blue hover:text-blue",
        subtle:
          "border-transparent bg-surface-2 text-fg-2 hover:bg-surface-3 hover:text-fg",
        // Flat like primary: solid fill, one ramp step darker on hover, no glow.
        danger: [
          "border-transparent bg-red text-white",
          "hover:bg-red-hover",
          "active:scale-[0.97]",
        ],
        // Destructive actions at rest look like a default (ghost) button and
        // only turn red — border and text — on hover, per the brand review.
        dangerGhost:
          "border-border-strong bg-surface text-fg hover:border-red hover:text-red",
        gh: "border-gh bg-gh text-gh-fg hover:bg-gh-hover",
      },
      size: {
        // No explicit leading here ON PURPOSE: <button> does not inherit the
        // body line-height — it uses the UA's `line-height: normal`, and the
        // legacy .btn sizing was built on that (e.g. 15px text → 44px button).
        md: "gap-2 rounded-control px-[15px] py-2.5 text-[15px] [&_svg]:size-4",
        sm: "gap-1.5 rounded-sm px-[11px] py-1.5 text-[13px] [&_svg]:size-3.5",
        lg: "gap-2 rounded-control px-[22px] py-[13px] text-[16px] [&_svg]:size-4",
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
