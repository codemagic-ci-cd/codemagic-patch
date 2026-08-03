# Vendored webfonts

Self-hosted because the dashboard ships behind a strict CSP (`default-src 'self'`):
the mockup's CDN `@import`s (cdnfonts / Google Fonts) are intentionally dropped.

## Metropolis (`Metropolis-*.woff2`)

- License: **Unlicense** (public domain) — <https://unlicense.org>
- Source: WOFF2 builds from the [`dw5/Metropolis`](https://github.com/dw5/Metropolis)
  mirror (`Fonts/Webfonts/WOFF2/`, Unlicense per the repo's `UNLICENSE` file) of the
  original `chrismsimpson/Metropolis` repository, which is no longer available on GitHub.
- Weights vendored: Regular (400), Medium (500), SemiBold (600), Bold (700; mapped to
  `font-weight:700 900` in `../fonts.css` to cover the design system's 800/900 usages).

## Fira Code (`FiraCode-*.woff2`)

- License: **SIL Open Font License 1.1** — <https://openfontlicense.org>
  (license text ships in the upstream release as `OFL.txt`).
- Source: [`tonsky/FiraCode`](https://github.com/tonsky/FiraCode) release
  [v6.2](https://github.com/tonsky/FiraCode/releases/tag/6.2) (`Fira_Code_v6.2.zip`,
  `woff2/` directory).
- Weights vendored: Regular (400), Medium (500; mapped to `font-weight:500 600` in
  `../fonts.css` to cover mono-600 usages).

The OFL permits bundling and redistribution with attribution and without selling the
fonts standalone; the Unlicense places Metropolis in the public domain. No font files
were modified.
