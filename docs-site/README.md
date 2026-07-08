# Codemagic Patch docs

Docusaurus site for [Codemagic Patch](https://github.com/codemagic-ci-cd/codemagic-patch) documentation.

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

Search requires a production build (`docusaurus start` alone does not index docs).

Add and edit pages under `docs/`. Documentation changes belong on the `docusaurus-experiment` branch.

This branch adds only the marketing landing page (`src/pages/index.tsx`, `HomeTerminal`, `dashboard.png`) on top of that docs branch.
