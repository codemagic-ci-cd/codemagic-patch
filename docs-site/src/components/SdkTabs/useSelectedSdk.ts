import {useEffect} from 'react';
import {useStorageSlot} from '@docusaurus/theme-common';
import {useLocation} from '@docusaurus/router';

import {
  SDK_QUERY_PARAM,
  SDK_TAB_CAPACITOR,
  SDK_TAB_REACT_NATIVE,
  SDK_TAB_STORAGE_KEY,
} from './constants';

export type SdkId = typeof SDK_TAB_REACT_NATIVE | typeof SDK_TAB_CAPACITOR;

export function sdkFromSearch(search: string): SdkId | null {
  const params = new URLSearchParams(
    search.startsWith('?') ? search.slice(1) : search,
  );
  const raw = params.get(SDK_QUERY_PARAM);
  if (raw === SDK_TAB_CAPACITOR) {
    return SDK_TAB_CAPACITOR;
  }
  if (raw === SDK_TAB_REACT_NATIVE) {
    return SDK_TAB_REACT_NATIVE;
  }
  return null;
}

export function withSdkSearch(search: string, sdk: SdkId): string {
  const params = new URLSearchParams(
    search.startsWith('?') ? search.slice(1) : search,
  );
  params.set(SDK_QUERY_PARAM, sdk);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function useSelectedSdk(): SdkId {
  const {search} = useLocation();
  const fromQuery = sdkFromSearch(search);
  const [stored] = useStorageSlot(SDK_TAB_STORAGE_KEY);
  if (fromQuery) {
    return fromQuery;
  }
  return stored === SDK_TAB_CAPACITOR ? SDK_TAB_CAPACITOR : SDK_TAB_REACT_NATIVE;
}

/** The SDK a doc's front matter tags it for (`sidebar_custom_props.sdk`), when it names exactly one. */
export function sdkFromFrontMatter(frontMatter: {
  sidebar_custom_props?: {[key: string]: unknown};
}): SdkId | null {
  const raw = frontMatter.sidebar_custom_props?.sdk;
  if (raw === SDK_TAB_CAPACITOR || raw === SDK_TAB_REACT_NATIVE) {
    return raw;
  }
  return null;
}

/**
 * An SDK-specific page selects its SDK, so samples, navigation and links followed from
 * it match the page. A `?sdk=` query still wins: the switcher handles that case.
 */
export function useSelectSdkForPage(pageSdk: SdkId | null): void {
  const {search} = useLocation();
  const [stored, slot] = useStorageSlot(SDK_TAB_STORAGE_KEY);
  const hasQuery = sdkFromSearch(search) !== null;

  useEffect(() => {
    if (pageSdk && !hasQuery && stored !== pageSdk) {
      slot.set(pageSdk);
    }
  }, [pageSdk, hasQuery, stored, slot]);
}
