# Codemagic Patch site

Docusaurus site for [Codemagic Patch](https://github.com/codemagic-ci-cd/codemagic-patch). Currently serves only the public marketing homepage; documentation pages will be added back incrementally.

## Local development

From the monorepo root:

```bash
yarn install
yarn workspace @codemagic/patch-docs-site start
```

Open [http://localhost:3002](http://localhost:3002). Port **3002** avoids clashing with the API dev server on 3000.

## Build

```bash
yarn workspace @codemagic/patch-docs-site build
yarn workspace @codemagic/patch-docs-site serve -- --port 3002
```

## Re-enabling docs

The docs plugin, local search, and the llms.txt pipeline are disabled while the site is homepage-only. To bring documentation back:

1. Restore the `docs/` directory (see the `docusaurus-experiment` branch for content).
2. Re-enable the commented `docs`, `docusaurus-plugin-llms`, and search-local blocks in `docusaurus.config.ts`, plus the navbar items.
3. Restore the llms build steps in `package.json` scripts (`apply-llms-descriptions.mjs`, `sync-md-to-static.mjs` under `scripts/` are kept for this).
