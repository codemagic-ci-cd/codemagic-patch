import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {createPortal} from 'react-dom';
import clsx from 'clsx';
import {useLocation} from '@docusaurus/router';
import useIsBrowser from '@docusaurus/useIsBrowser';
import SearchBar from '@theme/SearchBar';

import styles from './styles.module.css';

type Props = {
  className?: string;
};

export default function SidebarSearch({className}: Props): ReactNode {
  const isBrowser = useIsBrowser();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const pathWhenOpened = useRef<string | null>(null);

  const close = useCallback(() => setOpen(false), []);
  const openModal = useCallback(() => {
    pathWhenOpened.current = location.pathname + location.search;
    setOpen(true);
  }, [location.pathname, location.search]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        openModal();
      }
      if (event.key === 'Escape' && open) {
        close();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, openModal, close]);

  useEffect(() => {
    if (!open) {
      return;
    }
    document.body.style.overflow = 'hidden';
    const input = modalRef.current?.querySelector<HTMLInputElement>(
      '.navbar__search-input',
    );
    input?.focus();
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const current = location.pathname + location.search;
    if (
      pathWhenOpened.current !== null &&
      current !== pathWhenOpened.current
    ) {
      close();
    }
  }, [location.pathname, location.search, open, close]);

  return (
    <>
      <div className={clsx(styles.shell, className)}>
        <button
          type="button"
          className={styles.trigger}
          onClick={openModal}
          aria-haspopup="dialog">
          <span className={styles.triggerLabel}>Search</span>
          <kbd className={styles.triggerHint}>⌘K</kbd>
        </button>
      </div>
      {open &&
        isBrowser &&
        createPortal(
          <div
            className={styles.overlay}
            onClick={close}
            role="presentation">
            <div
              ref={modalRef}
              className={styles.modal}
              onClick={(event) => event.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-label="Search documentation">
              <SearchBar />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
