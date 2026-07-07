import React, {type ReactNode} from 'react';
import clsx from 'clsx';

import styles from './styles.module.css';

type Props = {
  className?: string;
};

export default function SidebarMaintainedBy({className}: Props): ReactNode {
  return (
    <div className={clsx(styles.wrapper, className)}>
      <a
        className={styles.maintainedBy}
        href="https://codemagic.io"
        target="_blank"
        rel="noopener noreferrer">
        Built by Codemagic
      </a>
    </div>
  );
}
