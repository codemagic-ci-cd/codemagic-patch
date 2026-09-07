import type { ImgHTMLAttributes } from "react";

import { PRODUCT_NAME } from "../../branding";

const PATCH_BRAND_ASSET = {
  lockup: "/logo.svg",
  mark: "/favicon.svg",
} as const;

export interface PatchBrandProps extends Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "alt" | "src"
> {
  variant?: keyof typeof PATCH_BRAND_ASSET;
  /** Use inside a link/button that already supplies the accessible name. */
  decorative?: boolean;
}

/** Canonical Patch lockup/mark rendering and accessibility contract. */
export function PatchBrand({
  variant = "lockup",
  decorative = false,
  ...props
}: PatchBrandProps) {
  return (
    <img
      {...props}
      src={PATCH_BRAND_ASSET[variant]}
      alt={decorative ? "" : PRODUCT_NAME}
      aria-hidden={decorative || undefined}
    />
  );
}
