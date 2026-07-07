/**
 * Top-level llms.txt sections. Keep in sync with docs-site/sidebars.ts.
 *
 * Nested sidebar categories are flattened into their parent section.
 * Troubleshooting is grouped under Optional per the llmstxt.org "Optional"
 * section convention.
 */
export const LLMS_SECTIONS = [
  {
    label: 'Overview',
    docIds: ['intro'],
  },
  {
    label: 'Introduction',
    docIds: ['introduction/how-it-works', 'introduction/core-concepts'],
  },
  {
    label: 'Setup',
    docIds: [
      'setup/requirements',
      'setup/self-host',
      'setup/cloudflare',
      'setup/cli',
      'setup/apps-deployments',
      'setup/native-setup',
      'setup/defining-update-checks',
      'setup/manual-control',
      'setup/first-release',
    ],
  },
  {
    label: 'Using Patch',
    docIds: [
      'using-patch/releasing-updates',
      'using-patch/code-signing',
      'using-patch/delivery',
    ],
  },
  {
    label: 'Reference',
    docIds: [
      'reference/cli-reference',
      'reference/configuration',
      'reference/operations',
    ],
  },
  {
    label: 'Optional',
    docIds: ['troubleshooting'],
  },
];
