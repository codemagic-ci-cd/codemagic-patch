import React, {type ReactNode} from 'react';
import {useDoc, useDocsSidebar} from '@docusaurus/plugin-content-docs/client';
import type {PropSidebarItem} from '@docusaurus/plugin-content-docs';
import DocPaginator from '@theme/DocPaginator';

import {itemMatchesSdk} from '@site/src/components/SdkTabs/filterSidebarItems';
import {useSelectedSdk, type SdkId} from '@site/src/components/SdkTabs/useSelectedSdk';

type NavLink = {permalink: string; title: string};

// The pages a reader of `sdk` can reach, in sidebar order. The current page always
// stays in, like the filtered sidebar keeps the active item.
function linksForSdk(
  items: readonly PropSidebarItem[],
  sdk: SdkId,
  currentDocId: string,
): (NavLink & {docId?: string})[] {
  const links: (NavLink & {docId?: string})[] = [];
  for (const item of items) {
    if (item.type === 'category') {
      if (!itemMatchesSdk(item, sdk)) {
        continue;
      }
      if (item.href) {
        links.push({permalink: item.href, title: item.label});
      }
      links.push(...linksForSdk(item.items, sdk, currentDocId));
      continue;
    }
    if (item.type !== 'link' || item.docId === undefined) {
      continue;
    }
    if (itemMatchesSdk(item, sdk) || item.docId === currentDocId) {
      links.push({permalink: item.href, title: item.label, docId: item.docId});
    }
  }
  return links;
}

// Docusaurus computes previous/next from the whole sidebar at build time, so
// a React Native page and its Capacitor counterpart would link to each other.
// Recompute them from the selected SDK's view of the sidebar.
export default function DocItemPaginator(): ReactNode {
  const {metadata} = useDoc();
  const sidebar = useDocsSidebar();
  const sdk = useSelectedSdk();

  let previous: NavLink | undefined = metadata.previous;
  let next: NavLink | undefined = metadata.next;

  if (sidebar) {
    const links = linksForSdk(sidebar.items, sdk, metadata.id);
    const index = links.findIndex((link) => link.docId === metadata.id);
    if (index !== -1) {
      previous = links[index - 1];
      next = links[index + 1];
    }
  }

  return (
    <DocPaginator
      className="docusaurus-mt-lg"
      previous={previous && {permalink: previous.permalink, title: previous.title}}
      next={next && {permalink: next.permalink, title: next.title}}
    />
  );
}
