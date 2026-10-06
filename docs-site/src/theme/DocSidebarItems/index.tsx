import React, {type ReactNode} from 'react';
import DocSidebarItems from '@theme-original/DocSidebarItems';
import type {Props} from '@theme/DocSidebarItems';

import SdkSwitcher from '@site/src/components/SdkSwitcher';
import {filterSidebarItemsForSdk} from '@site/src/components/SdkTabs/filterSidebarItems';
import {useSelectedSdk} from '@site/src/components/SdkTabs/useSelectedSdk';

import styles from './styles.module.css';

export default function SdkFilteredDocSidebarItems(props: Props): ReactNode {
  const sdk = useSelectedSdk();
  const items = filterSidebarItemsForSdk(props.items, sdk, props.activePath);
  const list = <DocSidebarItems {...props} items={items} />;

  if (props.level !== 1) {
    return list;
  }

  return (
    <>
      <li className={styles.switcherItem}>
        <SdkSwitcher />
      </li>
      {list}
    </>
  );
}
