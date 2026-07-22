# Codemagic Patch docs

Docusaurus site for [Codemagic Patch](https://github.com/codemagic-ci-cd/codemagic-patch) documentation.

This package is standalone (not a yarn workspace). Install and run from `docs-site/`.

## Local development

```bash
cd docs-site
npm install
npm start
```

Open [http://localhost:3002](http://localhost:3002). Port **3002** avoids clashing with the API dev server on 3000.

## Build

```bash
cd docs-site
npm run build
npm run serve -- --port 3002
```

Search requires a production build (`docusaurus start` alone does not index docs).

Add and edit pages under `docs/`.
