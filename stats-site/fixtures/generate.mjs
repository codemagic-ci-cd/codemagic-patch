// Regenerates the page fixtures (empty, young, large, stale, broken) from fixed
// seeds so the files review as diffs and screenshots stay stable:
//
//   node stats-site/fixtures/generate.mjs
//
// Every timestamp is anchored on FIXTURE_CLOCK_ISO in stats.js, the "now" the
// page uses in fixture mode: `stale` was generated four days before it, the
// others a few hours before it. Each series ends on the UTC day before its
// generation, as servers report the previous day. `validate.test.mjs` checks that the committed
// files equal this generator's output, that all but `broken` pass the
// structural check, and that all but `stale` and `broken` are live at that clock.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_ATTEMPTS = 100;
// Mirrors the collector rule in stats.v1.schema.json: a day's rate is null
// below 20 attempts.
const MIN_DAY_ATTEMPTS = 20;

/** mulberry32: small, seedable, good enough for synthetic series. */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function toIsoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayRangeEndingOn(lastDay, count) {
  const end = Date.parse(`${lastDay}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) =>
    toIsoDay(end - (count - 1 - index) * DAY_MS),
  );
}

function isWeekend(day) {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}

function ratio(numerator, denominator) {
  return denominator === 0
    ? null
    : Math.round((numerator / denominator) * 1e6) / 1e6;
}

function sumKnown(values) {
  return values.reduce((total, value) => total + (value ?? 0), 0);
}

const NULL_ROW = {
  active_devices: null,
  applied: null,
  failed: null,
  releases: null,
  rollbacks: null,
  reporting_coverage: null,
};

function buildLargeRows(days) {
  const random = createRandom(20261013);
  // Two days the collector missed entirely, and one day where a single tiny
  // instance was the only report (below the 20-attempt floor).
  const missingDays = new Set(["2026-08-20", "2026-08-21"]);
  const tinyDay = "2026-09-05";

  return days.map((day, index) => {
    if (missingDays.has(day)) {
      return { ...NULL_ROW };
    }
    if (day === tinyDay) {
      return {
        active_devices: 1431,
        applied: 11,
        failed: 2,
        releases: 0,
        rollbacks: 0,
        reporting_coverage: 0.02,
      };
    }
    const growth = 1 + index * 0.0025;
    const weekend = isWeekend(day);
    const activeDevices = Math.round(
      1_850_000 * growth * (weekend ? 0.86 : 1) * (0.97 + random() * 0.06),
    );
    const applied = Math.round(
      activeDevices * (weekend ? 0.16 : 0.21) * (0.9 + random() * 0.2),
    );
    const failed = Math.round(applied * (0.00018 + random() * 0.00025));
    const releases = weekend
      ? Math.round(40 + random() * 50)
      : Math.round(240 + random() * 180);
    const rollbacks = Math.round(releases * (0.015 + random() * 0.02));
    const reportingCoverage = Math.round((0.93 + random() * 0.06) * 1000) / 1000;
    return {
      active_devices: activeDevices,
      applied,
      failed,
      releases,
      rollbacks,
      reporting_coverage: reportingCoverage,
    };
  });
}

function buildYoungRows(days) {
  const random = createRandom(20261005);
  return days.map((day, index) => {
    const activeDevices = Math.round(120 + index * 15 + random() * 25);
    const applied = Math.round(25 + index * 3 + random() * 12);
    const failed = random() < 0.4 ? 1 : 0;
    return {
      active_devices: activeDevices,
      applied,
      failed: index === 3 ? 2 : failed,
      releases: Math.round(random() * 4),
      rollbacks: index === 5 ? 1 : 0,
      reporting_coverage: 1,
    };
  });
}

function buildStaleRows(days) {
  const random = createRandom(20260831);
  return days.map(() => {
    const applied = Math.round(random() * 5);
    return {
      active_devices: Math.round(30 + random() * 50),
      applied,
      failed: random() < 0.08 ? 1 : 0,
      releases: random() < 0.25 ? 1 : 0,
      rollbacks: 0,
      reporting_coverage: random() < 0.9 ? 1 : 0.5,
    };
  });
}

function assembleDocument({
  days,
  rows,
  firstDay,
  generatedAt,
  nextUpdateAfter,
  lagDays,
  instancesReporting30d,
  managedInstances30d,
  managedTeamsWithApp,
  selfHostedServers30d,
  appliedBeforeWindow,
  releasesBeforeWindow,
  notes,
}) {
  const active = rows.map((row) => row.active_devices);
  const applied = rows.map((row) => row.applied);
  const failed = rows.map((row) => row.failed);
  const attempts = rows.map((row) =>
    row.applied === null ? null : row.applied + row.failed,
  );
  const successRate = rows.map((row, index) => {
    const dayAttempts = attempts[index];
    return dayAttempts === null || dayAttempts < MIN_DAY_ATTEMPTS
      ? null
      : ratio(row.applied, dayAttempts);
  });
  const releases = rows.map((row) => row.releases);
  const rollbacks = rows.map((row) => row.rollbacks);
  const reportingCoverage = rows.map((row) => row.reporting_coverage);

  const lastIndex = rows.length - 1;
  const last30 = rows.slice(-30);
  const applied30 = sumKnown(last30.map((row) => row.applied));
  const failed30 = sumKnown(last30.map((row) => row.failed));
  const attempts30 = applied30 + failed30;
  const last7 = rows.slice(-7);

  return {
    schema_version: 1,
    status: "ok",
    generated_at: generatedAt,
    next_update_after: nextUpdateAfter,
    coverage: {
      first_day: firstDay,
      last_reported_day: days[lastIndex],
      lag_days: lagDays,
      min_report_days: 2,
      instances_reporting_30d: instancesReporting30d,
      notes,
    },
    totals: {
      active_devices: {
        day: days[lastIndex],
        value: active[lastIndex],
        last_7_days: active.slice(-7),
      },
      success_rate_30d: {
        applied: applied30,
        failed: failed30,
        attempts: attempts30,
        rate: attempts30 >= MIN_ATTEMPTS ? ratio(applied30, attempts30) : null,
        min_attempts: MIN_ATTEMPTS,
      },
      teams: {
        value: managedTeamsWithApp + selfHostedServers30d,
        managed_teams_with_app: managedTeamsWithApp,
        self_hosted_servers_30d: selfHostedServers30d,
      },
      self_hosted_servers_30d: { value: selfHostedServers30d },
      managed_instances_30d: managedInstances30d,
      releases_7d: {
        releases: sumKnown(last7.map((row) => row.releases)),
        rollbacks: sumKnown(last7.map((row) => row.rollbacks)),
      },
      applied_since_first_day: sumKnown(applied) + appliedBeforeWindow,
      releases_since_first_day: sumKnown(releases) + releasesBeforeWindow,
    },
    timeseries: {
      days,
      active_devices: active,
      applied,
      failed,
      attempts,
      success_rate: successRate,
      releases,
      rollbacks,
      reporting_coverage: reportingCoverage,
    },
  };
}

const COMMON_NOTES = [
  "Managed hosting reports as one population alongside self-hosted servers.",
];

export function generateFixtures() {
  const largeDays = dayRangeEndingOn("2026-10-21", 98);
  const large = assembleDocument({
    days: largeDays,
    rows: buildLargeRows(largeDays),
    firstDay: "2026-06-09",
    generatedAt: "2026-10-22T03:30:12Z",
    nextUpdateAfter: "2026-10-22T15:30:00Z",
    lagDays: 1,
    instancesReporting30d: 88,
    managedInstances30d: 2,
    managedTeamsWithApp: 1214,
    selfHostedServers30d: 86,
    appliedBeforeWindow: 9_412_880,
    releasesBeforeWindow: 7_215,
    notes: COMMON_NOTES,
  });

  const youngDays = dayRangeEndingOn("2026-10-21", 9);
  const young = assembleDocument({
    days: youngDays,
    rows: buildYoungRows(youngDays),
    firstDay: youngDays[0],
    generatedAt: "2026-10-22T03:30:05Z",
    nextUpdateAfter: "2026-10-22T15:30:00Z",
    lagDays: 1,
    instancesReporting30d: 4,
    managedInstances30d: 1,
    managedTeamsWithApp: 2,
    selfHostedServers30d: 3,
    appliedBeforeWindow: 0,
    releasesBeforeWindow: 0,
    notes: [],
  });

  const staleDays = dayRangeEndingOn("2026-10-17", 40);
  const stale = assembleDocument({
    days: staleDays,
    rows: buildStaleRows(staleDays),
    firstDay: staleDays[0],
    generatedAt: "2026-10-18T03:30:00Z",
    nextUpdateAfter: "2026-10-18T15:30:00Z",
    lagDays: 1,
    instancesReporting30d: 2,
    managedInstances30d: 0,
    managedTeamsWithApp: 0,
    selfHostedServers30d: 2,
    appliedBeforeWindow: 0,
    releasesBeforeWindow: 0,
    notes: [],
  });

  const empty = {
    schema_version: 1,
    status: "warming",
    generated_at: "2026-10-22T03:30:00Z",
    next_update_after: "2026-10-22T15:30:00Z",
    coverage: {
      first_day: null,
      last_reported_day: null,
      lag_days: 0,
      min_report_days: 2,
      instances_reporting_30d: 0,
      notes: [],
    },
    totals: {
      active_devices: null,
      success_rate_30d: {
        applied: 0,
        failed: 0,
        attempts: 0,
        rate: null,
        min_attempts: MIN_ATTEMPTS,
      },
      teams: { value: 0, managed_teams_with_app: 0, self_hosted_servers_30d: 0 },
      self_hosted_servers_30d: { value: 0 },
      managed_instances_30d: 0,
      releases_7d: { releases: 0, rollbacks: 0 },
      applied_since_first_day: 0,
      releases_since_first_day: 0,
    },
    timeseries: {
      days: [],
      active_devices: [],
      applied: [],
      failed: [],
      attempts: [],
      success_rate: [],
      releases: [],
      rollbacks: [],
      reporting_coverage: [],
    },
  };

  // Same document as `young` with the series removed: fails the structural
  // check, so the page must fall back instead of rendering it.
  const { timeseries: _dropped, ...broken } = young;

  return { empty, young, large, stale, broken };
}

export function serializeFixture(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));

export function readCommittedFixture(name) {
  return readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf8");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [name, document] of Object.entries(generateFixtures())) {
    writeFileSync(join(FIXTURES_DIR, `${name}.json`), serializeFixture(document));
    console.log(`wrote ${name}.json`);
  }
}
