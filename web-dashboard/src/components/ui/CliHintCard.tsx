// Copyable CLI snippet card ("uploads are CLI-only" -- a `release-react`
// command pre-filled by the caller). Visual contract: `.section-title` with
// the magenta server glyph, dim caption, and a `.codeblock` with
// `tok-cmd`/`tok-flag`/`tok-str` highlighting plus the floating copy button.
//
// Copying shares Copyable's clipboard logic; on the selectable-text fallback
// the command (already fully visible) is range-selected for manual copy.

import { useEffect, useRef } from "react";

import {
  CODEBLOCK,
  CODEBLOCK_COPY_BTN,
  CODEBLOCK_COPY_BTN_COPIED,
  CODEBLOCK_COPY_BTN_IDLE,
  CODEBLOCK_TOKEN,
} from "./codeblock";
import { CheckIcon, CopyIcon, useCopyState } from "./Copyable";
import { CARD, CARD_PAD } from "./card";
import { SECTION_TITLE } from "./typography";

interface CommandToken {
  kind: "cmd" | "flag" | "str" | "plain";
  text: string;
}

function tokenizeCommand(command: string): CommandToken[] {
  const parts = command.match(/"[^"]*"|'[^']*'|\s+|[^\s"']+/g) ?? [];
  const tokens: CommandToken[] = [];
  let sawCommand = false;
  for (const part of parts) {
    if (/^\s+$/.test(part)) {
      tokens.push({ kind: "plain", text: part });
    } else if (part.startsWith('"') || part.startsWith("'")) {
      tokens.push({ kind: "str", text: part });
    } else if (part.startsWith("--") || part === "\\") {
      tokens.push({ kind: "flag", text: part });
    } else if (!sawCommand) {
      sawCommand = true;
      tokens.push({ kind: "cmd", text: part });
    } else {
      tokens.push({ kind: "plain", text: part });
    }
  }
  return tokens;
}

function ServerIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-[18px] text-magenta"
    >
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <line x1="7" y1="7.5" x2="7" y2="7.5" />
      <line x1="7" y1="16.5" x2="7" y2="16.5" />
    </svg>
  );
}

export interface CliHintCardProps {
  /** Full CLI command written to the clipboard, e.g. a pre-filled `cmpatch release-react ...`. */
  command: string;
  /** Supporting line under the title. */
  caption?: string;
  title?: string;
}

export function CliHintCard({
  command,
  caption = "Uploads happen from the CLI / CI. This snippet is pre-filled for this deployment.",
  title = "Upload from the CLI",
}: CliHintCardProps) {
  const { state, copy } = useCopyState();
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (state !== "fallback") {
      return;
    }
    const node = codeRef.current;
    if (node === null) {
      return;
    }
    const selection = window.getSelection();
    if (selection === null) {
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  }, [state]);

  const copied = state === "copied";

  return (
    <div className={`${CARD} ${CARD_PAD}`}>
      <div className={SECTION_TITLE}>
        <ServerIcon /> {title}
      </div>
      <p className="mt-2 mb-3 text-[13px] text-fg-2">{caption}</p>
      <div className={CODEBLOCK}>
        <button
          type="button"
          className={`${CODEBLOCK_COPY_BTN} ${
            copied ? CODEBLOCK_COPY_BTN_COPIED : CODEBLOCK_COPY_BTN_IDLE
          }`}
          aria-label="Copy command"
          onClick={() => void copy(command)}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
        <code ref={codeRef} className="whitespace-pre-wrap">
          {tokenizeCommand(command).map((token, index) =>
            token.kind === "plain" ? (
              token.text
            ) : (
              <span key={index} className={CODEBLOCK_TOKEN[token.kind]}>
                {token.text}
              </span>
            ),
          )}
        </code>
      </div>
      <span role="status" className="sr-only">
        {copied
          ? "Copied to clipboard"
          : state === "fallback"
            ? "Clipboard unavailable -- command selected, copy it manually"
            : ""}
      </span>
    </div>
  );
}
