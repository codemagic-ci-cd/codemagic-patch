import React, {type ReactNode} from 'react';
import Tabs from '@theme/Tabs';

import {SDK_QUERY_PARAM, SDK_TAB_GROUP_ID} from './constants';

import styles from './styles.module.css';

export default function SdkTabs({children}: {children: ReactNode}): ReactNode {
  return (
    <div className={styles.sdkTabs}>
      <Tabs groupId={SDK_TAB_GROUP_ID} queryString={SDK_QUERY_PARAM}>{children}</Tabs>
    </div>
  );
}
