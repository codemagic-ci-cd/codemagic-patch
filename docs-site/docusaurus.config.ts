import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

import llmsPlugin from "./plugins/llms";

const siteUrl = process.env.PATCH_DOCS_SITE_URL ?? "http://localhost:3002";
const baseUrl = process.env.PATCH_DOCS_BASE_URL ?? "/docs/";
const enablePlausible = siteUrl === "https://patch.codemagic.io";

const llmsIndex = {
  title: "Codemagic Patch documentation",
  description:
    "Self-hosted OTA updates for React Native: setup, SDK, cmpatch CLI, and operations.",
};

const config: Config = {
  title: "Codemagic Patch",
  tagline: "Self-hosted OTA updates for React Native",
  favicon: "img/favicon.svg",

  url: siteUrl,
  baseUrl,

  onBrokenLinks: "throw",

  markdown: {
    mermaid: true,
  },

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  headTags: enablePlausible
    ? [
        {
          tagName: "script",
          attributes: {},
          innerHTML:
            "window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}},plausible.init();",
        },
        {
          tagName: "script",
          attributes: {
            src: "https://plausible.io/js/pa-jKOLGzZkYuZEmSgJnLC4O.js",
            async: "true",
          },
        },
      ]
    : [],

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          sidebarCollapsed: false,
          breadcrumbs: false,
          routeBasePath: "/",
        },
        blog: false,
        pages: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    [
      "@docusaurus/plugin-client-redirects",
      {
        redirects: [
          {
            from: ["/setup/cloudflare", "/setup/cloudfront"],
            to: "/reference/cdn",
          },
        ],
      },
    ],
    // llms.txt and per-page markdown twins; see plugins/llms/index.ts.
    (context) => llmsPlugin(context, llmsIndex),
    // llms-full.txt only: its llms.txt and markdown files use doc-id paths
    // that do not match page URLs.
    [
      "docusaurus-plugin-llms",
      {
        ...llmsIndex,
        generateLLMsTxt: false,
        generateLLMsFullTxt: true,
        generateMarkdownFiles: false,
        excludeImports: true,
        removeDuplicateHeadings: true,
      },
    ],
  ],

  clientModules: [
    require.resolve("./src/clientModules/legacyHomeAnchors.ts"),
  ],

  themes: [
    require.resolve("@docusaurus/theme-mermaid"),
    [
      require.resolve("@easyops-cn/docusaurus-search-local"),
      {
        hashed: true,
        language: ["en"],
        docsRouteBasePath: "/",
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
      logo: {
        alt: "Codemagic Patch",
        src: "img/logo.svg",
        href: baseUrl,
      },
    },
    footer: {
      style: "light",
      copyright: `Built by Codemagic. © ${new Date().getFullYear()} Nevercode Ltd.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
    mermaid: {
      theme: { light: "neutral", dark: "dark" },
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
