# Vendored webfonts

Self-hosted because the dashboard ships behind a strict CSP (`default-src 'self'`):
the mockup's CDN `@import`s (cdnfonts / Google Fonts) are intentionally dropped.

## Metropolis (`Metropolis-*.woff2`)

- Same files as `docs-site/static/fonts/` (the Codemagic docs/marketing cut).
- Weights: Regular (400), Medium (500), SemiBold (600), Bold (700). The brand
  kit has no ExtraBold; `font-extrabold` falls back to Bold.

## Fira Code (`FiraCode-*.woff2`)

- License: **SIL Open Font License 1.1** — <https://openfontlicense.org>
  (license text ships in the upstream release as `OFL.txt`).
- Source: [`tonsky/FiraCode`](https://github.com/tonsky/FiraCode) release
  [v6.2](https://github.com/tonsky/FiraCode/releases/tag/6.2) (`Fira_Code_v6.2.zip`,
  `woff2/` directory).
- Weights vendored: Regular (400), Medium (500; mapped to `font-weight:500 600` in
  `../fonts.css` to cover mono-600 usages).

The OFL permits bundling and redistribution with attribution and without selling the
fonts standalone. No font files were modified.
