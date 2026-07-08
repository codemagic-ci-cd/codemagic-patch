import React, {type ReactNode} from 'react';

import styles from './styles.module.css';

type Props = {
  label: string;
  children: string;
};

export default function HomeTerminal({label, children}: Props): ReactNode {
  return (
    <div className={styles.terminal}>
      <div className={styles.bar}>
        <span className={styles.dots} aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className={styles.label}>{label}</span>
      </div>
      <pre className={styles.body}>
        <code>{children}</code>
      </pre>
    </div>
  );
}
