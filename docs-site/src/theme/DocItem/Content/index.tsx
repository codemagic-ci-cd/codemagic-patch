import React, {type ReactNode} from 'react';
import clsx from 'clsx';
import {ThemeClassNames} from '@docusaurus/theme-common';
import {useDoc} from '@docusaurus/plugin-content-docs/client';
import Heading from '@theme/Heading';
import MDXContent from '@theme/MDXContent';
import type {Props} from '@theme/DocItem/Content';
import SendToAI from '@site/src/components/SendToAI';

import styles from './styles.module.css';

const MINIMAL_DOC_PAGE_IDS = new Set(['changelog', 'roadmap']);

export default function DocItemContent({children}: Props): ReactNode {
  const {metadata, frontMatter} = useDoc();
  const hideTitle = frontMatter.hide_title === true;
  const hideSendToAI =
    MINIMAL_DOC_PAGE_IDS.has(metadata.id) ||
    (frontMatter as {hide_send_to_ai?: boolean}).hide_send_to_ai === true;
  const showTitleRow = !hideTitle;

  return (
    <div
      className={clsx(
        ThemeClassNames.docs.docMarkdown,
        'markdown',
        showTitleRow && styles.hasPageTitle,
      )}>
      {showTitleRow && (
        <header className={styles.titleRow}>
          <Heading as="h1" className={styles.title}>
            {metadata.title}
          </Heading>
          {!hideSendToAI && <SendToAI />}
        </header>
      )}
      <MDXContent>{children}</MDXContent>
    </div>
  );
}
