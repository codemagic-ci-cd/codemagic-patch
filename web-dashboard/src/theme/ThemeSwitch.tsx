// Light / Dark / System segmented control. Profile is the only call site.
// Default is System. Persistence is client-only (see preference.ts).

import { useSyncExternalStore } from "react";

import {
  readThemePreference,
  subscribeThemePreference,
  writeThemePreference,
  type ThemePreference,
} from "./preference";

const OPTIONS: readonly { value: ThemePreference; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

const SEGMENTED =
  "inline-flex gap-[3px] rounded-control border border-border bg-surface-2 p-[3px]";
const SEGMENTED_BTN =
  "rounded-[8px] border-0 px-[14px] py-[7px] text-[13px] font-semibold [transition:.13s]";
const SEGMENTED_BTN_IDLE = "bg-transparent text-fg-2";
const SEGMENTED_BTN_ACTIVE = "bg-surface text-blue shadow-xs";

export function ThemeSwitch() {
  const preference = useSyncExternalStore(
    subscribeThemePreference,
    readThemePreference,
    () => "system" as const,
  );

  return (
    <div role="group" aria-label="Appearance" className={SEGMENTED}>
      {OPTIONS.map((option) => {
        const active = preference === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            className={`${SEGMENTED_BTN} ${active ? SEGMENTED_BTN_ACTIVE : SEGMENTED_BTN_IDLE}`}
            onClick={() => {
              writeThemePreference(option.value);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
