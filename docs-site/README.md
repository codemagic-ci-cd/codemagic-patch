# Codemagic Patch site

Docusaurus site for [Codemagic Patch](https://github.com/codemagic-ci-cd/codemagic-patch): the public marketing homepage plus a minimal docs set mirroring the repository root README. Remaining documentation pages are added back incrementally.

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

## Adding docs back

The current `docs/` set covers what the repository root README covers. Pages beyond that scope (comparison, migration guides, SDK reference, FAQ, changelog, local quickstart/development, dashboard, infrastructure adapters, production control, CI integration, verify-test-release, analytics, security, preparing-for-production) live on the `docusaurus-experiment` / `docusaurus-homepage` branches. To restore one:

1. `git checkout <branch> -- docs-site/docs/<page>.mdx`
2. Add its doc id to `sidebars.ts` and `scripts/llms-sidebar-sections.mjs`.
3. Build — `onBrokenLinks: 'throw'` will surface any links that still need targets.
