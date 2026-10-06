import {isActiveSidebarItem} from '@docusaurus/plugin-content-docs/client';
import type {PropSidebarItem} from '@docusaurus/plugin-content-docs';

import type {SdkId} from './useSelectedSdk';

function sdkFromCustomProps(item: PropSidebarItem): SdkId[] | null {
  const raw = item.customProps?.sdk;
  if (typeof raw === 'string') {
    return [raw as SdkId];
  }
  if (Array.isArray(raw) && raw.every((value) => typeof value === 'string')) {
    return raw as SdkId[];
  }
  return null;
}

export function itemMatchesSdk(item: PropSidebarItem, sdk: SdkId): boolean {
  const allowed = sdkFromCustomProps(item);
  return allowed == null || allowed.includes(sdk);
}

export function filterSidebarItemsForSdk(
  items: readonly PropSidebarItem[],
  sdk: SdkId,
  activePath: string,
): PropSidebarItem[] {
  const result: PropSidebarItem[] = [];
  for (const item of items) {
    const keepForActivePage = isActiveSidebarItem(item, activePath);
    if (item.type === 'category') {
      const children = filterSidebarItemsForSdk(item.items, sdk, activePath);
      if (!itemMatchesSdk(item, sdk) && !keepForActivePage) {
        continue;
      }
      if (children.length === 0 && !item.href && !keepForActivePage) {
        continue;
      }
      result.push({...item, items: children});
      continue;
    }
    if (!itemMatchesSdk(item, sdk) && !keepForActivePage) {
      continue;
    }
    result.push(item);
  }
  return result;
}
