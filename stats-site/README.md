# Codemagic Patch public stats page

The static page behind <https://patch.codemagic.io/stats/>. It renders the
public stats document the telemetry collector serves at
`https://telemetry.codemagicpatch.dev/v1/stats.json` (schema:
`shared/schemas/stats.v1.schema.json`). No framework, no bundler, no runtime
dependencies.

| Path | What it is |
| --- | --- |
| `public/` | The page as shipped: `index.html`, `stats.css`, `stats.js` (one ES module: exported pure logic first, DOM rendering second), `boot.js` (theme restore before first paint plus a "script never ran" watchdog), fonts, icons, `og.png`. |
| `fixtures/` | Synthetic stats documents for development and staging (`empty`, `young`, `large`, `stale`, `broken`). Regenerate with `node stats-site/fixtures/generate.mjs`. |

## Page layout

Top to bottom: the navy hero with the title; three tiles (active devices with
a seven-day sparkline, teams using Patch, self-hosted servers); **Updates
applied**, a bar chart of updates applied per ISO week, and **Shipping
velocity**, a bar chart of releases per ISO week, both over the same last
twelve weeks and dashed for a week with fewer than seven reported days; and
**Try Patch**, the public repository link and the ngrok self-host install with a copy
button. Charts are inline SVG with a pointer and keyboard readout and an
`aria-label` that states the range and the latest value. A document without
an eligible report yet shows a notice in place of the charts, and the banner
above the hero identifies a saved last-good document when the live document is unavailable.

## Previewing the page

Serve a copy of `public/` under `/stats/` (the page's asset URLs are absolute)
with the fixtures next to it, and open it with `?fixture=<name>`. An unbuilt
copy has no live source configured, so without a fixture the page only says
that the stats are unavailable:

```sh
preview=$(mktemp -d)
mkdir "$preview/stats"
cp -R stats-site/public/. stats-site/fixtures "$preview/stats"
python3 -m http.server 4173 -d "$preview"   # http://127.0.0.1:4173/stats/?fixture=large
```

`?fixture=<name>` is honoured only where fixtures were enabled: unbuilt copies
and staging builds, never production. Fixture runs use a fixed clock
(`FIXTURE_CLOCK_ISO`), so their freshness never depends on today's date, and
they never touch the browser's last good copy.

## How the page chooses what to show

1. A structurally valid saved last-good document is rendered immediately when
   available, while the page refreshes the live API. A fresh (under 72 hours
   old), structurally valid live document replaces it and is remembered in
   `localStorage`.
2. A 404 from the collector means the public stats are paused; it overrides any
   saved document.
3. Otherwise the newest valid copy among a stale live response and the saved
   document is shown behind a banner naming its generation time and the reason.
4. With nothing valid at hand the page says the stats are unavailable. It never
   invents a number. Fixtures never read or write the saved copy.

## Maintainer-only commands

The tests, the build, and the deployment are not part of the public
repository: `test/`, the root `build:static-stats` script, the
`scripts/*_patch_stats_static_site.sh` scripts, and the `patch-stats-staging` /
`patch-stats-production` workflows in `codemagic.yaml` stay internal.

```sh
node --test 'stats-site/test/*.test.mjs'                 # formatting, ISO weeks and weekly sums, the structural check, source selection and freshness, chart logic (gaps, view choice)
PATCH_SITE_ENVIRONMENT=staging yarn build:static-stats   # writes build/stats/ and validates it
python3 -m http.server 4173 -d build                     # http://127.0.0.1:4173/stats/?fixture=large
```

The tests are pure functions only, no DOM, and fail when the committed
fixtures drift from the generator. The build substitutes the placeholders in
`index.html` and `stats.js` (live source URL and CSP origin, fixtures flag,
analytics flag), copies fixtures on staging only, and makes no network
requests. Production builds load Plausible and ship no fixtures.

Deployment uses the `scripts/*_patch_stats_static_site.sh` scripts and the
`patch-stats-staging` / `patch-stats-production` workflows in `codemagic.yaml`,
mirroring the docs site.
