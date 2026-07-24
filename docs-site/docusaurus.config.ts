import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'Codemagic Patch',
  tagline: 'Self-hosted OTA updates for React Native',
  favicon: 'img/favicon.svg',

  url: 'http://localhost:3002',
  baseUrl: '/',

  onBrokenLinks: 'throw',

  markdown: {
    mermaid: true,
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          sidebarCollapsed: false,
          breadcrumbs: false,
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    [
      'docusaurus-plugin-llms',
      {
        generateLLMsTxt: true,
        generateLLMsFullTxt: true,
        generateMarkdownFiles: true,
        title: 'Codemagic Patch documentation',
        description:
          'Self-hosted OTA updates for React Native: setup, SDK, cmpatch CLI, and operations.',
        excludeImports: true,
        removeDuplicateHeadings: true,
      },
    ],
  ],

  themes: [
    require.resolve('@docusaurus/theme-mermaid'),
    [
      require.resolve('@easyops-cn/docusaurus-search-local'),
      {
        hashed: true,
        language: ['en'],
        docsRouteBasePath: '/docs',
        indexBlog: false,
        highlightSearchTermsOnTargetPage: true,
      },
    ],
  ],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },
    docs: {
      sidebar: {
        autoCollapseCategories: false,
      },
    },
    navbar: {
      title: 'Patch',
      logo: {
        alt: 'Codemagic Patch',
        src: 'img/logo.svg',
        href: '/',
      },
      items: [
        {
          type: 'doc',
          docId: 'intro',
          position: 'left',
          label: 'Docs',
        },
        {
          type: 'doc',
          docId: 'roadmap',
          position: 'left',
          label: 'Roadmap',
        },
        {
          type: 'doc',
          docId: 'changelog',
          position: 'left',
          label: 'Changelog',
        },
      ],
    },
    footer: {
      style: 'light',
      links: [
        {
          title: 'Docs',
          items: [
            {
              label: 'Local quickstart',
              to: '/docs/',
            },
            {
              label: 'Install guide',
              to: '/docs/install',
            },
          ],
        },
        {
          title: 'Codemagic',
          items: [
            {
              label: 'Codemagic.io',
              href: 'https://codemagic.io',
            },
            {
              label: 'CodePush',
              href: 'https://codemagic.io/codepush',
            },
          ],
        },
      ],
      copyright: `Built by Codemagic. © ${new Date().getFullYear()} Nevercode Ltd.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
    mermaid: {
      theme: {light: 'neutral', dark: 'dark'},
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
