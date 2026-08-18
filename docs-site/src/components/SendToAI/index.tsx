import React, {useEffect, useRef, useState, type ReactNode} from 'react';
import clsx from 'clsx';
import useBaseUrl from '@docusaurus/useBaseUrl';
import {useDoc} from '@docusaurus/plugin-content-docs/client';

import {resolveMarkdownPath} from '@site/src/utils/resolveMarkdownPath';

import styles from './styles.module.css';

type CopyState = 'idle' | 'copied' | 'error';
type CopyTarget = 'markdown' | 'link';

function useMdPath(): string {
  const {metadata, frontMatter} = useDoc();
  const slug =
    typeof frontMatter.slug === 'string' ? frontMatter.slug : undefined;
  return useBaseUrl(resolveMarkdownPath(metadata.id, slug));
}

function getAbsoluteUrl(path: string): string {
  return new URL(path, window.location.origin).href;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'absolute';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function CopyIcon(): ReactNode {
  return (
    <svg
      className={styles.menuIcon}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function ChevronIcon({open}: {open: boolean}): ReactNode {
  return (
    <svg
      className={clsx(styles.chevron, open && styles.chevronOpen)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export default function SendToAI(): ReactNode {
  const mdPath = useMdPath();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [copiedTarget, setCopiedTarget] = useState<CopyTarget | null>(null);
  const [errorTarget, setErrorTarget] = useState<CopyTarget | null>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      if (!rootRef.current || rootRef.current.contains(event.target as Node)) {
        return;
      }
      setOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, []);

  useEffect(() => {
    if (!copiedTarget && !errorTarget) {
      return;
    }

    const timer = window.setTimeout(() => {
      setCopiedTarget(null);
      setErrorTarget(null);
    }, 2000);

    return () => window.clearTimeout(timer);
  }, [copiedTarget, errorTarget]);

  const handleCopyLink = async () => {
    try {
      await copyText(getAbsoluteUrl(mdPath));
      setCopiedTarget('link');
      setErrorTarget(null);
      setOpen(false);
    } catch {
      setErrorTarget('link');
      setCopiedTarget(null);
    }
  };

  const handleCopyMarkdown = async () => {
    try {
      const response = await fetch(mdPath);
      if (!response.ok) {
        throw new Error(`Failed to fetch markdown (${response.status})`);
      }
      await copyText(await response.text());
      setCopiedTarget('markdown');
      setErrorTarget(null);
      setOpen(false);
    } catch {
      setErrorTarget('markdown');
      setCopiedTarget(null);
      setOpen(false);
    }
  };

  const statusLabel = errorTarget
    ? 'Copy failed — run npm run refresh:md, then restart the dev server'
    : copiedTarget === 'markdown'
      ? 'Markdown copied'
      : copiedTarget === 'link'
        ? 'Link copied'
        : null;

  return (
    <div className={styles.wrapper} ref={rootRef}>
      <button
        type="button"
        className={clsx(styles.trigger, open && styles.triggerOpen)}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}>
        <span>Send to AI</span>
        <ChevronIcon open={open} />
      </button>

      {open ? (
        <div className={styles.menu} role="menu">
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            onClick={handleCopyMarkdown}>
            <CopyIcon />
            <span className={styles.menuLabel}>Copy markdown</span>
          </button>
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            onClick={handleCopyLink}>
            <CopyIcon />
            <span className={styles.menuLabel}>Copy .md link</span>
          </button>
        </div>
      ) : null}

      {statusLabel ? (
        <p
          className={clsx(styles.status, errorTarget && styles.statusError)}
          role="status">
          {statusLabel}
        </p>
      ) : null}
    </div>
  );
}
