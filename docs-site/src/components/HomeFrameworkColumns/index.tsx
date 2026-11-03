import React, {type ReactNode} from 'react';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';

import {
  SDK_TAB_CAPACITOR,
  SDK_TAB_REACT_NATIVE,
} from '@site/src/components/SdkTabs/constants';

import styles from './styles.module.css';

const COLUMNS = [
  {
    title: 'React Native',
    subtitle: 'OTA updates for JavaScript and bundled assets',
    sdk: SDK_TAB_REACT_NATIVE,
    sdkSetup: '/setup/native-setup',
  },
  {
    title: 'Capacitor',
    subtitle: 'Live updates for your web assets',
    sdk: SDK_TAB_CAPACITOR,
    sdkSetup: '/setup/native-setup-capacitor',
  },
] as const;

function FrameworkColumn({
  title,
  subtitle,
  sdk,
  sdkSetup,
}: (typeof COLUMNS)[number]): ReactNode {
  const quickstart = useBaseUrl('/local-quickstart');
  const install = useBaseUrl('/install');
  const setup = useBaseUrl(sdkSetup);

  return (
    <div className={styles.column}>
      <h2 className={styles.title}>{title}</h2>
      <p className={styles.subtitle}>{subtitle}</p>
      <ul className={styles.list}>
        <li>
          <Link to={`${quickstart}?sdk=${sdk}`}>Local quickstart</Link>
        </li>
        <li>
          <Link to={`${install}?sdk=${sdk}`}>Server install</Link>
        </li>
        <li>
          <Link to={`${setup}?sdk=${sdk}`}>App setup</Link>
        </li>
      </ul>
    </div>
  );
}

export default function HomeFrameworkColumns(): ReactNode {
  return (
    <div className={styles.grid}>
      {COLUMNS.map((column) => (
        <FrameworkColumn key={column.sdk} {...column} />
      ))}
    </div>
  );
}
