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
        // Docs are disabled while the site is homepage-only. Restore this
        // block (and the docs/ directory) to bring documentation back:
        // docs: {
        //   sidebarPath: './sidebars.ts',
        //   sidebarCollapsed: false,
        // },
        docs: false,
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  // docs-dependent plugins/themes, disabled until documentation returns:
  // plugins: [
  //   [
  //     'docusaurus-plugin-llms',
  //     {
  //       generateLLMsTxt: true,
  //       generateLLMsFullTxt: true,
  //       generateMarkdownFiles: true,
  //       title: 'Codemagic Patch documentation',
  //       description:
  //         'Self-hosted OTA updates for React Native: setup, SDK, cmpatch CLI, and operations.',
  //       excludeImports: true,
  //       removeDuplicateHeadings: true,
  //     },
  //   ],
  // ],

  themes: [
    require.resolve('@docusaurus/theme-mermaid'),
    // [
    //   require.resolve('@easyops-cn/docusaurus-search-local'),
    //   {
    //     hashed: true,
    //     language: ['en'],
    //     docsRouteBasePath: '/docs',
    //     indexBlog: false,
    //     highlightSearchTermsOnTargetPage: true,
    //     searchBarPosition: 'left',
    //   },
    // ],
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
      title: 'Codemagic Patch',
      logo: {
        alt: 'Codemagic Patch',
        src: 'img/logo.svg',
        href: '/',
      },
      // Docs and Changelog navbar entries return together with the docs
      // plugin (type: 'doc' items require it).
      items: [],
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
