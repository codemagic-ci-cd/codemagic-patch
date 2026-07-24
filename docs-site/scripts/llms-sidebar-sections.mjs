/**
 * Top-level llms.txt sections. Keep in sync with docs-site/sidebars.ts.
 *
 * Nested sidebar categories are flattened into their parent section.
 * Troubleshooting, FAQ, and Changelog are grouped under Optional per the
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
      'introduction/pricing',
    ],
  },
  {
    label: 'Setup',
    docIds: [
      'setup/install',
      'setup/cloudflare',
      'setup/infrastructure',
      'setup/ongoing-maintenance',
      'setup/apps-deployments',
      'setup/native-setup',
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
    docIds: ['troubleshooting', 'faq', 'roadmap', 'changelog'],
  },
];
