/** Shared `groupId` for React Native vs Capacitor Tabs. Persist via Docusaurus `docusaurus.tab.sdk`. */
export const SDK_TAB_GROUP_ID = 'sdk';

export const SDK_TAB_STORAGE_KEY = `docusaurus.tab.${SDK_TAB_GROUP_ID}`;

/** `?sdk=capacitor` / `?sdk=react-native` overrides the stored framework. */
export const SDK_QUERY_PARAM = SDK_TAB_GROUP_ID;

export const SDK_TAB_REACT_NATIVE = 'react-native';
export const SDK_TAB_CAPACITOR = 'capacitor';

/** Doc ids that should navigate to a counterpart when the SDK dropdown changes. */
export const SDK_DOC_ALTERNATES: Record<
  string,
  Partial<Record<'react-native' | 'capacitor', string>>
> = {
  'introduction/comparison': {
    capacitor: '/introduction/comparison-capacitor',
  },
  'introduction/comparison-capacitor': {
    'react-native': '/introduction/comparison',
  },
  'setup/native-setup': {
    capacitor: '/setup/native-setup-capacitor',
  },
  'setup/native-setup-capacitor': {
    'react-native': '/setup/native-setup',
  },
  'migration/migrating-from-codepush': {
    capacitor: '/migration/migrating-from-appflow',
  },
  'migration/migrating-from-appflow': {
    'react-native': '/migration/migrating-from-codepush',
  },
  'using-patch/fingerprinting': {
    capacitor: '/using-patch/binary-version-capacitor',
  },
  'using-patch/binary-version-capacitor': {
    'react-native': '/using-patch/fingerprinting',
  },
};
