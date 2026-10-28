/**
 * Top-level llms.txt sections, by doc id. Keep in sync with docs-site/sidebars.ts.
 *
 * Nested sidebar categories are flattened into their parent section.
 * Troubleshooting and FAQ are grouped under Optional per the
 * llmstxt.org "Optional" section convention.
 */
export type LlmsSection = {label: string; docIds: string[]};

export const LLMS_SECTIONS: LlmsSection[] = [
  {
    label: 'Overview',
    docIds: ['intro'],
  },
  {
    label: 'Introduction',
    docIds: [
      'introduction/how-it-works',
      'introduction/core-concepts',
      'introduction/comparison',
      'introduction/comparison-capacitor',
      'introduction/pricing',
      'introduction/support',
    ],
  },
  {
    label: 'Setup',
    docIds: [
      'setup/install',
      'setup/cloudflare',
      'setup/cloudfront',
      'setup/infrastructure',
      'setup/ongoing-maintenance',
      'setup/native-setup',
      'setup/native-setup-capacitor',
      'setup/checking-for-updates',
      'setup/applying-updates',
      'setup/manual-control',
      'setup/testing',
      'setup/first-release',
    ],
  },
  {
    label: 'Using Patch',
    docIds: [
      'using-patch/dashboard',
      'using-patch/releasing-updates',
      'using-patch/fingerprinting',
      'using-patch/binary-version-capacitor',
      'using-patch/verify-test-release',
      'using-patch/preparing-for-production',
      'using-patch/production-control',
      'using-patch/ci-integration',
      'using-patch/analytics',
      'using-patch/security',
      'using-patch/delivery',
    ],
  },
  {
    label: 'Migration',
    docIds: [
      'migration/migrating-from-codepush',
      'migration/migrating-from-appflow',
      'migration/migrating-from-expo-updates',
    ],
  },
  {
    label: 'Reference',
    docIds: [
      'reference/sdk-reference',
      'reference/cli-reference',
      'reference/configuration',
      'reference/operations',
    ],
  },
  {
    label: 'Optional',
    docIds: [
      'troubleshooting',
      'faq',
      'releases/index',
      'releases/react-native',
      'releases/cli',
      'releases/capacitor-sdk',
      'releases/capacitor-cli',
      'releases/server',
    ],
  },
];

/** The "Where to start" list at the top of llms.txt, by doc id. */
export const LLMS_START_HERE: {label: string; docId: string}[] = [
  {label: 'Try Patch locally', docId: 'intro'},
  {label: 'How it works', docId: 'introduction/how-it-works'},
  {label: 'Install for production', docId: 'setup/install'},
  {label: 'Migrate from CodePush', docId: 'migration/migrating-from-codepush'},
  {
    label: 'Migrate from Expo Updates',
    docId: 'migration/migrating-from-expo-updates',
  },
  {label: 'CLI reference', docId: 'reference/cli-reference'},
  {label: 'SDK reference', docId: 'reference/sdk-reference'},
  {label: 'Debugging OTA issues', docId: 'troubleshooting'},
];
