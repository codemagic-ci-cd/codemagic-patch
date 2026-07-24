import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import matter from 'gray-matter';

import {LLMS_SECTIONS} from './llms-sidebar-sections.mjs';

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(siteDir, 'docs');
const llmsPath = path.join(siteDir, 'build', 'llms.txt');

const TOC_LINE =
  /^- \[([^\]]+)\]\(([^)]+)\)(?:: (.*))?$/;

const LINK_RESOLUTION_NOTE =
  'Doc links are site paths (e.g. `/docs/faq.md`). Resolve them against this file\'s origin — the host where you fetched `/llms.txt`.';

const LLMS_PREAMBLE = [
  LINK_RESOLUTION_NOTE,
  '',
  'Codemagic Patch is self-hosted over-the-air (OTA) updates for React Native — server, `cmpatch` CLI, and `@codemagic/react-native-patch` SDK.',
  '',
  '**Where to start**',
  '- Try Patch locally → `/intro/local-quickstart.md`',
  '- How it works → `/docs/introduction/how-it-works.md`',
  '- Install for production → `/docs/install.md`',
  '- Migrate from CodePush → `/docs/migration/migrating-from-codepush.md`',
  '- Migrate from Expo Updates → `/docs/migration/migrating-from-expo-updates.md`',
  '- CLI reference → `/docs/reference/cli-reference.md`',
  '- SDK reference → `/docs/reference/sdk-reference.md`',
  '- Debugging OTA issues → `/docs/troubleshooting.md`',
  '',
  'Sections below mirror the docs sidebar. **Optional** lists secondary pages (FAQ, changelog)—skip when you need a shorter context.',
];

function toSitePath(url) {
  if (url.startsWith('/')) {
    return url;
  }

  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function formatTocLine(title, url, description) {
  const sitePath = toSitePath(url);
  if (description?.trim()) {
    return `- [${title}](${sitePath}): ${description}`;
  }

  return `- [${title}](${sitePath})`;
}

function resolveMarkdownPath(docId, slug) {
  const normalizedSlug =
    typeof slug === 'string' ? slug.trim().replace(/^\/+|\/+$/g, '') : '';

  if (normalizedSlug) {
    if (normalizedSlug.includes('/')) {
      return `/${normalizedSlug}.md`;
    }

    return `/docs/${normalizedSlug}.md`;
  }

  return `/docs/${docId}.md`;
}

async function walkMdxFiles(dir) {
  const entries = await fs.readdir(dir, {withFileTypes: true});
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkMdxFiles(fullPath)));
      continue;
    }

    if (entry.name.endsWith('.mdx') || entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files;
}

async function buildDocRegistry() {
  const files = await walkMdxFiles(docsDir);
  const registry = new Map();

  for (const filePath of files) {
    const source = await fs.readFile(filePath, 'utf8');
    const {data} = matter(source);
    const docId = path
      .relative(docsDir, filePath)
      .replace(/\\/g, '/')
      .replace(/\.mdx?$/, '');
    const slug = typeof data.slug === 'string' ? data.slug : undefined;
    const mdPath = resolveMarkdownPath(docId, slug);
    const title =
      typeof data.title === 'string' && data.title.trim().length > 0
        ? data.title.trim()
        : docId;
    const llmsDescription =
      typeof data.llmsDescription === 'string'
        ? data.llmsDescription.trim()
        : '';

    registry.set(docId, {docId, mdPath, title, llmsDescription});
  }

  return registry;
}

function parseLlmsFile(content) {
  const lines = content.split('\n');
  const entries = new Map();
  let titleLine = '';
  let quoteLine = '';
  let index = 0;

  if (lines[index]?.startsWith('# ')) {
    titleLine = lines[index];
    index += 1;
  }

  while (index < lines.length && lines[index] === '') {
    index += 1;
  }

  if (lines[index]?.startsWith('> ')) {
    quoteLine = lines[index];
    index += 1;
  }

  for (const line of lines) {
    const tocMatch = line.match(TOC_LINE);
    if (!tocMatch) {
      continue;
    }

    const [, title, url, description] = tocMatch;
    entries.set(toSitePath(url), {title, description});
  }

  return {titleLine, quoteLine, entries};
}

function buildLlmsHeader(titleLine, quoteLine) {
  const header = [];

  if (titleLine) {
    header.push(titleLine, '');
  }

  if (quoteLine) {
    header.push(quoteLine, '');
  }

  header.push(...LLMS_PREAMBLE);

  return header;
}

function buildGroupedToc(registry, entries) {
  const sectionBlocks = [];
  const usedDocIds = new Set();

  for (const section of LLMS_SECTIONS) {
    const lines = [];

    for (const docId of section.docIds) {
      const doc = registry.get(docId);
      if (!doc) {
        console.warn(
          `apply-llms-descriptions: missing doc "${docId}" for section "${section.label}"`,
        );
        continue;
      }

      usedDocIds.add(docId);
      const entry = entries.get(doc.mdPath);
      const title = entry?.title ?? doc.title;
      const description = doc.llmsDescription || entry?.description;

      lines.push(formatTocLine(title, doc.mdPath, description));
    }

    if (lines.length === 0) {
      continue;
    }

    sectionBlocks.push(`## ${section.label}\n\n${lines.join('\n')}`);
  }

  for (const doc of registry.values()) {
    if (usedDocIds.has(doc.docId)) {
      continue;
    }

    console.warn(
      `apply-llms-descriptions: "${doc.docId}" is not assigned to an llms.txt section`,
    );
  }

  return sectionBlocks.join('\n\n');
}

/** Strip MDX UI components from generated `.md` files shared with AI. */
const UI_COMPONENT_LINE = /^\s*<[A-Z][A-Za-z0-9]*\s*\/?>\s*$/;

const MD_AI_INDEX_BANNER =
  "> **Documentation index:** fetch `/llms.txt` from this site's origin for the full table of contents and links to every page.";

const MD_AI_INDEX_BANNER_LINE = /^> \*\*Documentation index:\*\*/;

const INTRO_AI_ADMONITION_BLOCK =
  /:::info Using these docs with AI\nUse this button to send your AI assistant to the full markdown index\.\n\n:::\n\n?/;

async function walkBuildMarkdownFiles(dir) {
  const entries = await fs.readdir(dir, {withFileTypes: true});
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkBuildMarkdownFiles(fullPath)));
      continue;
    }

    if (entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files;
}

function stripExistingAiBanner(content) {
  const lines = content.split('\n');
  if (!lines[0]?.match(MD_AI_INDEX_BANNER_LINE)) {
    return content;
  }

  let index = 1;
  while (index < lines.length && lines[index] === '') {
    index += 1;
  }

  return lines.slice(index).join('\n');
}

function patchMarkdownContent(content, {isIntro = false} = {}) {
  let patched = content
    .split('\n')
    .filter((line) => !UI_COMPONENT_LINE.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();

  if (isIntro) {
    patched = patched.replace(INTRO_AI_ADMONITION_BLOCK, '');
  }

  patched = stripExistingAiBanner(patched);

  return `${MD_AI_INDEX_BANNER}\n\n${patched}\n`;
}

async function patchGeneratedMarkdownForAi() {
  const buildDocsDir = path.join(siteDir, 'build', 'docs');

  try {
    await fs.access(buildDocsDir);
  } catch {
    return;
  }

  const markdownFiles = await walkBuildMarkdownFiles(buildDocsDir);
  const introMdPath = path.join(buildDocsDir, 'intro.md');

  for (const filePath of markdownFiles) {
    const content = await fs.readFile(filePath, 'utf8');
    const patched = patchMarkdownContent(content, {
      isIntro: filePath === introMdPath,
    });
    await fs.writeFile(filePath, patched);
  }

  console.log(
    `apply-llms-descriptions: patched ${markdownFiles.length} markdown files for AI`,
  );
}

async function applyLlmsDescriptions() {
  const registry = await buildDocRegistry();
  const llms = await fs.readFile(llmsPath, 'utf8');
  const {titleLine, quoteLine, entries} = parseLlmsFile(llms);
  const groupedToc = buildGroupedToc(registry, entries);
  const output = [...buildLlmsHeader(titleLine, quoteLine), '', groupedToc, ''];

  await fs.writeFile(llmsPath, `${output.join('\n')}\n`);
  await patchGeneratedMarkdownForAi();
  console.log(
    `apply-llms-descriptions: updated build/llms.txt (${LLMS_SECTIONS.length} sections, ${registry.size} docs)`,
  );
}

try {
  await fs.access(llmsPath);
} catch {
  console.error(
    'apply-llms-descriptions: build/llms.txt not found — run "npm run build" first.',
  );
  process.exit(1);
}

await applyLlmsDescriptions();
