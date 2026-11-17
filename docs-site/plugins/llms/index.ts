import fs from 'node:fs/promises';
import path from 'node:path';

import matter from 'gray-matter';
import type {LoadContext, Plugin} from '@docusaurus/types';
import type {
  DocMetadata,
  LoadedContent as DocsLoadedContent,
} from '@docusaurus/plugin-content-docs';
// Same cleanup docusaurus-plugin-llms applies to llms-full.txt, so the
// per-page twins and the full file read the same.
import {
  cleanMarkdownContent,
  resolvePartialImports,
} from 'docusaurus-plugin-llms/lib/utils';

import {markdownTwinPath} from '../../src/utils/markdownTwin';
import {LLMS_SECTIONS, LLMS_START_HERE} from './sections';

/**
 * Agent-facing outputs, following llmstxt.org as subpath-hosted docs sites
 * use it:
 *
 * - every docs page gets a markdown twin at its URL plus `.md`
 *   (see `markdownTwinPath`);
 * - `<baseUrl>llms.txt` lists the twins by absolute URL, grouped like the
 *   sidebar.
 *
 * `llms-full.txt` still comes from docusaurus-plugin-llms. In `docusaurus
 * start` the same files are served from `.docusaurus/llms/`, so the Send to
 * AI menu works without a build.
 */

type Options = {title: string; description: string};

const UI_COMPONENT_LINE = /^\s*<[A-Z][A-Za-z0-9]*\s*\/?>\s*$/;
const MDX_COMMENT = /\{\/\*[\s\S]*?\*\/\}/g;

const AI_ADMONITION_BLOCK =
  /:::info Using these docs with AI\nUse this button to send your AI assistant to the full markdown index\.\n\n:::\n\n?/;

function sourcePath(siteDir: string, doc: DocMetadata): string {
  return path.join(siteDir, doc.source.replace(/^@site\//, ''));
}

function frontMatterString(doc: DocMetadata, key: string): string {
  const value = (doc.frontMatter as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

async function renderTwin(
  siteDir: string,
  doc: DocMetadata,
  banner: string,
): Promise<string> {
  const filePath = sourcePath(siteDir, doc);
  const {content} = matter(await fs.readFile(filePath, 'utf8'));
  const cleaned = cleanMarkdownContent(
    await resolvePartialImports(content, filePath),
    true,
    true,
  );

  // MDX comments are authoring notes; they never render, so they never ship.
  const lines = cleaned
    .replace(MDX_COMMENT, '')
    .trimStart()
    .split('\n')
    .filter((line) => !UI_COMPONENT_LINE.test(line));
  // The title heading is written below; drop the page's own copy of it.
  if (lines[0]?.trim() === `# ${doc.title}`) {
    lines.shift();
  }
  const body = lines
    .join('\n')
    .replace(AI_ADMONITION_BLOCK, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const description = frontMatterString(doc, 'description');
  const header = description
    ? `# ${doc.title}\n\n> ${description}`
    : `# ${doc.title}`;

  return `${banner}\n\n${header}\n\n${body}\n`;
}

function renderLlmsTxt(
  options: Options,
  docsById: Map<string, DocMetadata>,
  absoluteUrl: (urlPath: string) => string,
): string {
  const twinUrl = (docId: string): string => {
    const doc = docsById.get(docId);
    if (!doc) {
      throw new Error(
        `llms plugin: plugins/llms/sections.ts names doc "${docId}", which does not exist`,
      );
    }
    return absoluteUrl(markdownTwinPath(doc.permalink));
  };

  const lines = [
    `# ${options.title}`,
    '',
    `> ${options.description}`,
    '',
    'Codemagic Patch is self-hosted over-the-air (OTA) updates for React Native (server, `cmpatch` CLI, and `@codemagic/react-native-patch` SDK). Codemagic can also host Patch on request.',
    '',
    '**Where to start**',
    ...LLMS_START_HERE.map(({label, docId}) => `- [${label}](${twinUrl(docId)})`),
    '',
    'Sections below mirror the docs sidebar. **Optional** lists secondary pages (FAQ, troubleshooting)—skip when you need a shorter context.',
  ];

  const assigned = new Set<string>();
  for (const section of LLMS_SECTIONS) {
    lines.push('', `## ${section.label}`, '');
    for (const docId of section.docIds) {
      const url = twinUrl(docId);
      const doc = docsById.get(docId)!;
      assigned.add(docId);
      const description =
        frontMatterString(doc, 'llmsDescription') ||
        frontMatterString(doc, 'description');
      lines.push(
        description
          ? `- [${doc.title}](${url}): ${description}`
          : `- [${doc.title}](${url})`,
      );
    }
  }

  for (const docId of docsById.keys()) {
    if (!assigned.has(docId)) {
      console.warn(
        `llms plugin: "${docId}" is not assigned to an llms.txt section in plugins/llms/sections.ts`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

export default function llmsPlugin(
  context: LoadContext,
  options: Options,
): Plugin {
  const {siteDir, siteConfig, baseUrl, outDir, generatedFilesDir} = context;
  const devDir = path.join(generatedFilesDir, 'llms');
  const absoluteUrl = (urlPath: string) => `${siteConfig.url}${urlPath}`;
  const llmsTxtPath = `${baseUrl}llms.txt`;

  // URL path (with baseUrl) → file contents.
  let files = new Map<string, string>();

  async function writeFiles(rootDir: string): Promise<void> {
    for (const [urlPath, contents] of files) {
      const filePath = path.join(rootDir, urlPath.slice(baseUrl.length));
      await fs.mkdir(path.dirname(filePath), {recursive: true});
      await fs.writeFile(filePath, contents);
    }
  }

  return {
    name: 'llms',

    async allContentLoaded({allContent}) {
      const docsContent = allContent['docusaurus-plugin-content-docs']
        ?.default as DocsLoadedContent | undefined;
      const docs = docsContent?.loadedVersions.flatMap((v) => v.docs) ?? [];
      const docsById = new Map(docs.map((doc) => [doc.id, doc]));

      const banner = [
        '> ## Documentation Index',
        `> Fetch the complete documentation index at: ${absoluteUrl(llmsTxtPath)}`,
        '> Use this file to discover all available pages before exploring further.',
      ].join('\n');

      const next = new Map<string, string>();
      next.set(llmsTxtPath, renderLlmsTxt(options, docsById, absoluteUrl));
      for (const doc of docs) {
        next.set(
          markdownTwinPath(doc.permalink),
          await renderTwin(siteDir, doc, banner),
        );
      }
      files = next;

      await fs.rm(devDir, {recursive: true, force: true});
      await writeFiles(devDir);
    },

    configureWebpack(_config, isServer) {
      if (isServer) {
        return {};
      }
      // Merged into the `docusaurus start` dev server config; ignored by builds.
      return {
        devServer: {
          static: [{publicPath: baseUrl, directory: devDir, watch: false}],
        },
      } as ReturnType<NonNullable<Plugin['configureWebpack']>>;
    },

    async postBuild() {
      await writeFiles(outDir);
      console.log(
        `llms plugin: wrote ${llmsTxtPath} and ${files.size - 1} markdown twins`,
      );
    },
  };
}
