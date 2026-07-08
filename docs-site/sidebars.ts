import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    'intro',
    {
      type: 'category',
      label: 'Introduction',
      collapsed: false,
      items: [
        'introduction/how-it-works',
        'introduction/core-concepts',
        'introduction/comparison',
      ],
    },
    {
      type: 'category',
      label: 'Setup',
      collapsed: false,
      items: [
        {
          type: 'category',
          label: 'Server',
          collapsible: false,
          items: [
            'setup/requirements',
            'setup/local-development',
            'setup/self-host',
            'setup/cloudflare',
            'setup/infrastructure',
            'setup/cli',
          ],
        },
        {
          type: 'category',
          label: 'App & SDK',
          collapsible: false,
          items: [
            'setup/apps-deployments',
            'setup/native-setup',
            'setup/defining-update-checks',
            'setup/manual-control',
            'setup/first-release',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'Using Patch',
      collapsed: false,
      items: [
        {
          type: 'category',
          label: 'Releases',
          collapsible: false,
          items: [
            'using-patch/dashboard',
            'using-patch/releasing-updates',
            'using-patch/verify-test-release',
            'using-patch/preparing-for-production',
            'using-patch/production-control',
          ],
        },
        {
          type: 'category',
          label: 'Operations',
          collapsible: false,
          items: [
            'using-patch/ci-integration',
            'using-patch/analytics',
            'using-patch/security',
            'using-patch/delivery',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'Migration',
      collapsed: false,
      items: [
        'migration/migrating-from-codepush',
        'migration/migrating-from-expo-updates',
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      collapsed: false,
      items: [
        'reference/sdk-reference',
        'reference/cli-reference',
        'reference/configuration',
        'reference/operations',
      ],
    },
    'troubleshooting',
    'faq',
    'roadmap',
  ],

  /** Changelog nav item only — keeps the left column without doc links */
  changelogSidebar: [],
};

export default sidebars;
