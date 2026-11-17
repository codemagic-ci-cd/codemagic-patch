import React, {type ReactNode} from 'react';
import {useLocation} from '@docusaurus/router';
import useBaseUrl from '@docusaurus/useBaseUrl';
import DocSidebarItems from '@theme-original/DocSidebarItems';
import type {Props} from '@theme/DocSidebarItems';

import SdkSwitcher from '@site/src/components/SdkSwitcher';
import {filterSidebarItemsForSdk} from '@site/src/components/SdkTabs/filterSidebarItems';
import {useSelectedSdk} from '@site/src/components/SdkTabs/useSelectedSdk';

import styles from './styles.module.css';

function docIdFromPathname(pathname: string, baseUrl: string): string {
  const prefix = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const path = pathname.startsWith(prefix)
    ? pathname.slice(prefix.length)
    : pathname;
  return path.replace(/^\/+|\/+$/g, '');
}

/** Framework filter applies to guide docs only, not releases or roadmap. */
function isGuidesDoc(docId: string): boolean {
  return docId !== 'roadmap' && !docId.startsWith('releases');
}

export default function SdkFilteredDocSidebarItems(props: Props): ReactNode {
  const location = useLocation();
  const baseUrl = useBaseUrl('/');
  const filterForSdk = isGuidesDoc(docIdFromPathname(location.pathname, baseUrl));
  const sdk = useSelectedSdk();
  const items = filterForSdk
    ? filterSidebarItemsForSdk(props.items, sdk, props.activePath)
    : props.items;
  const list = <DocSidebarItems {...props} items={items} />;

  if (props.level !== 1 || !filterForSdk) {
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
