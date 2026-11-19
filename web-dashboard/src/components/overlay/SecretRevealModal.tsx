// Show-once secret dialog. The value is displayed exactly once, so the dialog
// cannot be dismissed by Esc, the overlay or an X: the only way out is the
// button, and that stays disabled until the reader confirms they saved the
// value. The copy control takes the initial focus. When the clipboard is
// unavailable the value is selected instead, so a manual copy is one
// keystroke.

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { buttonVariants } from "../ui/Button";
import { CALLOUT, CALLOUT_TONE } from "../ui/callout";
import {
  CODEBLOCK,
  CODEBLOCK_COPY_BTN,
  CODEBLOCK_COPY_BTN_COPIED,
  CODEBLOCK_COPY_BTN_IDLE,
} from "../ui/codeblock";
import { CheckIcon, CopyIcon, useCopyState } from "../ui/Copyable";
import { Modal } from "./Modal";

export interface SecretRevealModalProps {
  /** What the reader ticks before the dialog lets them leave. */
  acknowledgement: string;
  description: string;
  /** Label of the only exit. */
  doneLabel: string;
  onDone: () => void;
  /** Names the value for assistive technology, e.g. "signing secret". */
  secretName: string;
  title: string;
  value: string;
  /** What to do with the value, shown above it. */
  warning: ReactNode;
}

export function SecretRevealModal({
  acknowledgement,
  description,
  doneLabel,
  onDone,
  secretName,
  title,
  value,
  warning,
}: SecretRevealModalProps) {
  const { state, copy } = useCopyState();
  const [acknowledged, setAcknowledged] = useState(false);
  const copyButtonRef = useRef<HTMLButtonElement | null>(null);
  const codeRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (state === "fallback") {
      selectNodeContents(codeRef.current);
    }
  }, [state]);

  const handleCopy = () => {
    if (state === "fallback") {
      selectNodeContents(codeRef.current);
      return;
    }
    void copy(value);
  };

  const copied = state === "copied";

  return (
    <Modal
      open
      // Unreachable: disableEscapeClose hides every dismissal path.
      onClose={() => {}}
      disableEscapeClose
      title={title}
      description={description}
      initialFocusRef={copyButtonRef}
      footer={
        <button
          type="button"
          className={buttonVariants({ intent: "primary" })}
          disabled={!acknowledged}
          onClick={onDone}
        >
          {doneLabel}
        </button>
      }
    >
      <div className={`${CALLOUT} ${CALLOUT_TONE.warn} mb-3.5`}>
        <div>{warning}</div>
      </div>
      <div className={CODEBLOCK}>
        <button
          type="button"
          ref={copyButtonRef}
          className={`${CODEBLOCK_COPY_BTN} ${
            copied ? CODEBLOCK_COPY_BTN_COPIED : CODEBLOCK_COPY_BTN_IDLE
          }`}
          aria-label={`Copy ${secretName} to clipboard`}
          onClick={handleCopy}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
        <code ref={codeRef}>{value}</code>
      </div>
      <span role="status" className="sr-only">
        {copied
          ? "Copied to clipboard"
          : state === "fallback"
            ? `Clipboard unavailable. The ${secretName} is selected; copy it manually.`
            : ""}
      </span>
      <label className="mt-3.5 flex items-center gap-2.5 text-[13px] font-semibold">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        {acknowledgement}
      </label>
    </Modal>
  );
}

function selectNodeContents(node: HTMLElement | null): void {
  const selection = window.getSelection();
  if (node === null || selection === null) {
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}
