import React, {useEffect, useState, type ReactNode} from 'react';
import clsx from 'clsx';
import useBaseUrl from '@docusaurus/useBaseUrl';

import styles from './styles.module.css';

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
      className={styles.icon}
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

export default function CopyLlmsFullLink(): ReactNode {
  const llmsPath = useBaseUrl('/llms.txt');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!copied && !error) {
      return;
    }

    const timer = window.setTimeout(() => {
      setCopied(false);
      setError(false);
    }, 2000);

    return () => window.clearTimeout(timer);
  }, [copied, error]);

  const handleCopy = async () => {
    try {
      const url = new URL(llmsPath, window.location.origin).href;
      await copyText(url);
      setCopied(true);
      setError(false);
    } catch {
      setCopied(false);
      setError(true);
    }
  };

  return (
    <div className={styles.wrapper}>
      <button
        type="button"
        className={clsx(styles.button, copied && styles.buttonCopied)}
        onClick={handleCopy}>
        <CopyIcon />
        <span>
          {copied
            ? 'Link copied'
            : error
              ? 'Copy failed — try again'
              : 'Copy llms.txt link'}
        </span>
      </button>
    </div>
  );
}
