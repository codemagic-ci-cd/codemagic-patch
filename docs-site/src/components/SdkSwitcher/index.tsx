import React, {useEffect, useRef, useState, type ReactNode} from 'react';
import clsx from 'clsx';
import {useStorageSlot} from '@docusaurus/theme-common';
import {useHistory, useLocation} from '@docusaurus/router';
import useBaseUrl from '@docusaurus/useBaseUrl';

import {
  SDK_DOC_ALTERNATES,
  SDK_TAB_CAPACITOR,
  SDK_TAB_REACT_NATIVE,
  SDK_TAB_STORAGE_KEY,
} from '@site/src/components/SdkTabs/constants';
import {
  sdkFromSearch,
  useSelectedSdk,
  withSdkSearch,
} from '@site/src/components/SdkTabs/useSelectedSdk';

import styles from './styles.module.css';

function docIdFromPathname(pathname: string, baseUrl: string): string {
  const prefix = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const path = pathname.startsWith(prefix)
    ? pathname.slice(prefix.length)
    : pathname;
  return path.replace(/^\/+|\/+$/g, '');
}

function docsPath(dest: string, baseUrl: string): string {
  const prefix = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${prefix}${dest}`;
}

function samePath(left: string, right: string): boolean {
  return left.replace(/\/$/, '') === right.replace(/\/$/, '');
}

const OPTIONS = [
  {value: SDK_TAB_REACT_NATIVE, label: 'React Native'},
  {value: SDK_TAB_CAPACITOR, label: 'Capacitor'},
] as const;

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

export default function SdkSwitcher(): ReactNode {
  const [stored, slot] = useStorageSlot(SDK_TAB_STORAGE_KEY);
  const selected = useSelectedSdk();
  const selectedLabel =
    OPTIONS.find((option) => option.value === selected)?.label ?? 'React Native';
  const location = useLocation();
  const history = useHistory();
  const baseUrl = useBaseUrl('/');
  const docId = docIdFromPathname(location.pathname, baseUrl);
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const fromQuery = sdkFromSearch(location.search);
    if (!fromQuery) {
      return;
    }
    if (stored !== fromQuery) {
      slot.set(fromQuery);
    }
    const dest = SDK_DOC_ALTERNATES[docId]?.[fromQuery];
    if (!dest) {
      return;
    }
    const nextPath = docsPath(dest, baseUrl);
    if (samePath(location.pathname, nextPath)) {
      return;
    }
    history.replace(`${nextPath}${location.search}${location.hash}`);
  }, [
    location.search,
    location.pathname,
    location.hash,
    stored,
    slot,
    docId,
    baseUrl,
    history,
  ]);

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

  return (
    <div className={styles.wrapper} ref={rootRef}>
      <button
        type="button"
        className={clsx(styles.trigger, open && styles.triggerOpen)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Framework: ${selectedLabel}`}
        onClick={() => setOpen((value) => !value)}>
        <span>{selectedLabel}</span>
        <ChevronIcon open={open} />
      </button>
      {open ? (
        <div className={styles.menu} role="listbox" aria-label="Framework">
          {OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === selected}
              className={clsx(
                styles.menuItem,
                option.value === selected && styles.menuItemSelected,
              )}
              onClick={() => {
                slot.set(option.value);
                const dest = SDK_DOC_ALTERNATES[docId]?.[option.value];
                const search = withSdkSearch(location.search, option.value);
                if (dest) {
                  history.push(
                    `${docsPath(dest, baseUrl)}${search}${location.hash}`,
                  );
                } else {
                  history.replace(
                    `${location.pathname}${search}${location.hash}`,
                  );
                }
                setOpen(false);
              }}>
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
