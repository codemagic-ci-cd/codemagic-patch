import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(siteDir, 'build');
const staticDir = path.join(siteDir, 'static');

async function copyMarkdownArtifacts(dir, base = buildDir) {
  const entries = await fs.readdir(dir, {withFileTypes: true});

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await copyMarkdownArtifacts(fullPath, base);
      continue;
    }

    const isMarkdown = entry.name.endsWith('.md');
    const isLlmIndex =
      entry.name === 'llms.txt' || entry.name === 'llms-full.txt';

    if (!isMarkdown && !isLlmIndex) {
      continue;
    }

    const relative = path.relative(base, fullPath);
    const destination = path.join(staticDir, relative);

    await fs.mkdir(path.dirname(destination), {recursive: true});
    await fs.copyFile(fullPath, destination);
  }
}

try {
  await fs.access(path.join(buildDir, 'docs', 'intro.md'));
} catch {
  console.error(
    'sync-md-to-static: run "npm run build" in docs-site before syncing markdown artifacts.',
  );
  process.exit(1);
}

await copyMarkdownArtifacts(buildDir);
console.log('sync-md-to-static: copied markdown artifacts from build/ to static/');
