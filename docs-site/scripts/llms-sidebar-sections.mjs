/**
 * Top-level llms.txt sections. Keep in sync with docs-site/sidebars.ts.
 *
 * Nested sidebar categories are flattened into their parent section.
 * Troubleshooting and FAQ are grouped under Optional per the
 * llmstxt.org "Optional" section convention.
 */
export const LLMS_SECTIONS = [
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
