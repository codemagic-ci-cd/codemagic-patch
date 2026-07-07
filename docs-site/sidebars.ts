import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

/**
 * Minimal docs set mirroring the repository root README. Pages beyond the
 * README's scope (comparison, migration guides, SDK reference, FAQ,
 * changelog, …) return incrementally from the docusaurus-experiment branch.
 */
const sidebars: SidebarsConfig = {
  docsSidebar: [
    'intro',
    {
      type: 'category',
      label: 'Introduction',
      collapsed: false,
      items: ['introduction/how-it-works', 'introduction/core-concepts'],
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
            'setup/self-host',
            'setup/cloudflare',
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
        'using-patch/releasing-updates',
        'using-patch/code-signing',
        'using-patch/delivery',
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      collapsed: false,
      items: [
        'reference/cli-reference',
        'reference/configuration',
        'reference/operations',
      ],
    },
    'troubleshooting',
  ],
};

export default sidebars;
