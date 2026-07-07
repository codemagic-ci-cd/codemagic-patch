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
  'Doc links are site paths (e.g. `/docs/troubleshooting.md`). Resolve them against this file\'s origin — the host where you fetched `/llms.txt`.';

const LLMS_PREAMBLE = [
  LINK_RESOLUTION_NOTE,
  '',
  'Codemagic Patch is self-hosted over-the-air (OTA) updates for React Native — server, `cmpatch` CLI, and `@codemagic/react-native-patch` SDK.',
  '',
  '**Where to start**',
  '- How it works → `/docs/introduction/how-it-works.md`',
  '- Self-host in production → `/docs/setup/self-host.md`',
  '- CLI reference → `/docs/reference/cli-reference.md`',
  '- Debugging OTA issues → `/docs/troubleshooting.md`',
  '',
  'Sections below mirror the docs sidebar. **Optional** lists secondary pages—skip when you need a shorter context.',
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

async function patchGeneratedMarkdownForAi() {
  const introMdPath = path.join(siteDir, 'build', 'docs', 'intro.md');

  try {
    await fs.access(introMdPath);
  } catch {
    return;
  }

  const content = await fs.readFile(introMdPath, 'utf8');
  const cleaned = content
    .split('\n')
    .filter((line) => !UI_COMPONENT_LINE.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();

  await fs.writeFile(introMdPath, `${cleaned}\n`);
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
