// Dark CLI codeblock literals (legacy `.codeblock` family), shared by
// CliCommandBuilder and the TokensPage show-once dialog. The copy button swaps its
// idle/copied skins wholesale (ternary, never appended) so no two co-applied
// classes set the same property — see Button.tsx for the no-merge contract.
export const CODEBLOCK =
  "relative overflow-auto rounded-md bg-inverse px-[18px] py-4 font-mono text-[12.5px]/[1.7] text-inverse-fg";

export const CODEBLOCK_COPY_BTN =
  "absolute right-[11px] top-[11px] grid h-[26px] w-7 place-items-center rounded-[7px] border-0 [transition:.13s] [&_svg]:size-[15px]";

export const CODEBLOCK_COPY_BTN_IDLE =
  "bg-[rgba(255,255,255,.09)] text-inverse-fg hover:bg-[rgba(255,255,255,.18)] hover:text-white";

export const CODEBLOCK_COPY_BTN_COPIED =
  "bg-[color-mix(in_srgb,var(--color-green)_25%,transparent)] text-code-ok";

/** Token-highlight classes (legacy `.tok-*`), keyed by token kind. */
export const CODEBLOCK_TOKEN = {
  cmd: "text-aqua",
  flag: "text-magenta",
  str: "text-code-str",
} as const;
