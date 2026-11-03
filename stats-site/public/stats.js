// Public stats page for patch.codemagic.io/stats/.
//
// One dependency-free ES module. The first half is pure logic (formatting,
// time, validation, source selection, chart geometry) and is exported so
// `node --test stats-site/test` can exercise it without a DOM; the second half
// renders into index.html and runs only when a `document` exists. New logic
// belongs in the first half.
//
// The build script substitutes the three `__…__` string constants below (live
// source URL, fixtures flag, analytics flag). An unsubstituted copy (the raw
// public/ directory served locally) behaves as a dev build: no live source,
// fixtures enabled, analytics off.

export const STATS_SOURCE_URL = "__PATCH_STATS_SOURCE_URL__";
const FIXTURES_FLAG = "__PATCH_STATS_FIXTURES__";
const PLAUSIBLE_FLAG = "__PATCH_STATS_PLAUSIBLE__";

export const FIXTURE_NAMES = Object.freeze(["empty", "young", "large", "stale", "broken"]);
// The "now" the page uses in fixture mode, so fixture freshness is stable: the
// fixtures are generated against this clock (fixtures/generate.mjs).
export const FIXTURE_CLOCK_ISO = "2026-10-22T12:00:00Z";
export const SNAPSHOT_PATH = "data/snapshot.json";
export const MAX_DOCUMENT_AGE_MS = 72 * 60 * 60 * 1000;
export const CHART_DAYS = 90;
export const WEEK_BUCKETS = 12;
export const EM_DASH = "—";

const DAY_MS = 24 * 60 * 60 * 1000;
const THEME_STORAGE_KEY = "patch-stats.theme";
const DOCUMENT_STORAGE_KEY = "patch-stats.last-good-document";
const PLACEHOLDER_PATTERN = /^__[A-Z0-9_]+__$/;

/* ----------------------------------------------------------------------------
   Formatting. Locale is pinned to en-US and every date is UTC so two visitors
   never read two different numbers from the same document.
   ------------------------------------------------------------------------- */

const INTEGER_FORMAT = new Intl.NumberFormat("en-US");
const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});
const SHORT_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  timeZone: "UTC",
});

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** Exact integer with en-US grouping; anything else renders as the em dash. */
export function formatInteger(value) {
  return Number.isInteger(value) ? INTEGER_FORMAT.format(value) : EM_DASH;
}

/** Axis-sized count: 999 stays "999", then "1.5k", "10k", "1.2M", "3B". */
export function compactNumber(value) {
  if (!isNumber(value)) {
    return EM_DASH;
  }
  const magnitude = Math.abs(value);
  if (magnitude < 1_000) {
    return INTEGER_FORMAT.format(value);
  }
  const [divisor, suffix] =
    magnitude < 1_000_000
      ? [1_000, "k"]
      : magnitude < 1_000_000_000
        ? [1_000_000, "M"]
        : [1_000_000_000, "B"];
  const scaled = Math.round((value / divisor) * 10) / 10;
  return `${Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(1)}${suffix}`;
}

function parseDate(value) {
  if (typeof value !== "string") {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Oct 13, 2026" for a day or timestamp, always in UTC. */
export function formatUtcDate(value) {
  const date = parseDate(value);
  return date === null ? EM_DASH : DATE_FORMAT.format(date);
}

/** "Oct 13" for axis labels. */
export function formatShortUtcDate(value) {
  const date = parseDate(value);
  return date === null ? EM_DASH : SHORT_DATE_FORMAT.format(date);
}

/** "Oct 22, 2026 · 03:30 UTC". */
export function formatUtcDateTime(value) {
  const date = parseDate(value);
  return date === null
    ? EM_DASH
    : `${DATE_FORMAT.format(date)} · ${TIME_FORMAT.format(date)} UTC`;
}

/* ----------------------------------------------------------------------------
   UTC days and ISO weeks.
   ------------------------------------------------------------------------- */

/** Milliseconds for a "YYYY-MM-DD" UTC day, or NaN. */
export function parseUtcDay(day) {
  return Date.parse(`${day}T00:00:00Z`);
}

function toIsoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day, count) {
  return toIsoDay(parseUtcDay(day) + count * DAY_MS);
}

/** The Monday that starts the ISO week containing `day`. */
export function isoWeekMonday(day) {
  const ms = parseUtcDay(day);
  const daysSinceMonday = (new Date(ms).getUTCDay() + 6) % 7;
  return toIsoDay(ms - daysSinceMonday * DAY_MS);
}

/** ISO 8601 week-numbering year and week of `day` (weeks start on Monday). */
export function isoWeekNumber(day) {
  const date = new Date(parseUtcDay(day));
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  // The ISO week belongs to the year of its Thursday.
  date.setUTCDate(date.getUTCDate() - daysSinceMonday + 3);
  const year = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  firstThursday.setUTCDate(
    firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3,
  );
  return {
    week: 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * DAY_MS)),
    year,
  };
}

/**
 * Sums daily releases into the newest `bucketCount` ISO weeks. A week with
 * fewer than seven reported days is `partial` (the series starts or ends
 * inside it, or the collector missed days); a week with no reported day at
 * all keeps a null sum.
 */
export function bucketWeeks(days, releases, bucketCount = WEEK_BUCKETS) {
  const byMonday = new Map();
  days.forEach((day, index) => {
    const monday = isoWeekMonday(day);
    let bucket = byMonday.get(monday);
    if (bucket === undefined) {
      const { year, week } = isoWeekNumber(day);
      bucket = {
        coveredDays: 0,
        isoWeek: week,
        isoYear: year,
        partial: true,
        releases: null,
        weekEnd: addDays(monday, 6),
        weekStart: monday,
      };
      byMonday.set(monday, bucket);
    }
    if (releases[index] !== null) {
      bucket.coveredDays += 1;
      bucket.releases = (bucket.releases ?? 0) + releases[index];
    }
  });
  return [...byMonday.values()]
    .sort((left, right) => (left.weekStart < right.weekStart ? -1 : 1))
    .slice(-bucketCount)
    .map((bucket) => ({ ...bucket, partial: bucket.coveredDays < 7 }));
}

/* ----------------------------------------------------------------------------
   Structural check. Mirrors stats.v1.schema.json: a document that fails it is
   treated as unavailable rather than rendered half-way.
   ------------------------------------------------------------------------- */

const DAY_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const SERIES_CHECKS = Object.freeze({
  active_devices: isCountOrNull,
  applied: isCountOrNull,
  attempts: isCountOrNull,
  failed: isCountOrNull,
  releases: isCountOrNull,
  reporting_coverage: isRatioOrNull,
  rollbacks: isCountOrNull,
  success_rate: isRatioOrNull,
});

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function isCountOrNull(value) {
  return value === null || isCount(value);
}

function isRatioOrNull(value) {
  return value === null || (isNumber(value) && value >= 0 && value <= 1);
}

function isDay(value) {
  return typeof value === "string" && DAY_PATTERN.test(value) && !Number.isNaN(parseUtcDay(value));
}

function isDayOrNull(value) {
  return value === null || isDay(value);
}

function isDateTime(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function checkFields(object, checks, path) {
  for (const [field, check] of Object.entries(checks)) {
    if (!check(object[field])) {
      return `${path}.${field} is missing or malformed`;
    }
  }
  return null;
}

export function validateStats(doc) {
  const reason = findStructuralProblem(doc);
  return reason === null ? { ok: true, reason: null } : { ok: false, reason };
}

function findStructuralProblem(doc) {
  if (!isObject(doc)) {
    return "document is not an object";
  }
  if (doc.schema_version !== 1) {
    return "schema_version is not 1";
  }
  if (doc.status !== "ok" && doc.status !== "warming") {
    return "status is not ok or warming";
  }
  if (!isDateTime(doc.generated_at) || !isDateTime(doc.next_update_after)) {
    return "generated_at or next_update_after is not a timestamp";
  }

  const { coverage, timeseries, totals } = doc;
  if (!isObject(coverage)) {
    return "coverage is missing";
  }
  const coverageProblem = checkFields(
    coverage,
    {
      first_day: isDayOrNull,
      instances_reporting_30d: isCount,
      lag_days: isCount,
      last_reported_day: isDayOrNull,
      min_report_days: (value) => isCount(value) && value >= 1,
      notes: (value) => Array.isArray(value) && value.every((note) => typeof note === "string"),
    },
    "coverage",
  );
  if (coverageProblem !== null) {
    return coverageProblem;
  }

  if (!isObject(totals)) {
    return "totals is missing";
  }
  const totalsProblem = checkFields(
    totals,
    {
      active_devices: (value) =>
        value === null ||
        (isObject(value) &&
          isDay(value.day) &&
          isCount(value.value) &&
          Array.isArray(value.last_7_days) &&
          value.last_7_days.length === 7 &&
          value.last_7_days.every(isCountOrNull)),
      applied_since_first_day: isCount,
      managed_instances_30d: isCount,
      releases_7d: (value) => isObject(value) && isCount(value.releases) && isCount(value.rollbacks),
      releases_since_first_day: isCount,
      self_hosted_servers_30d: (value) => isObject(value) && isCount(value.value),
      success_rate_30d: (value) =>
        isObject(value) &&
        isCount(value.applied) &&
        isCount(value.failed) &&
        isCount(value.attempts) &&
        isRatioOrNull(value.rate) &&
        isCount(value.min_attempts) &&
        value.min_attempts >= 1,
      teams: (value) =>
        isObject(value) &&
        isCount(value.value) &&
        isCount(value.managed_teams_with_app) &&
        isCount(value.self_hosted_servers_30d),
    },
    "totals",
  );
  if (totalsProblem !== null) {
    return totalsProblem;
  }

  if (!isObject(timeseries)) {
    return "timeseries is missing";
  }
  const { days } = timeseries;
  if (!Array.isArray(days) || !days.every(isDay)) {
    return "timeseries.days is missing or malformed";
  }
  for (let index = 1; index < days.length; index += 1) {
    if (days[index] <= days[index - 1]) {
      return "timeseries.days is not strictly ascending";
    }
  }
  for (const [series, check] of Object.entries(SERIES_CHECKS)) {
    const values = timeseries[series];
    if (!Array.isArray(values) || values.length !== days.length) {
      return `timeseries.${series} does not parallel timeseries.days`;
    }
    if (!values.every(check)) {
      return `timeseries.${series} holds a malformed value`;
    }
  }
  return null;
}

/** No eligible report yet: the collector says so, or there is simply no day. */
export function isWarming(doc) {
  return (
    doc.status === "warming" ||
    doc.coverage.first_day === null ||
    doc.timeseries.days.length === 0
  );
}

/* ----------------------------------------------------------------------------
   Source selection: live document, deploy-time snapshot, last good copy.
   ------------------------------------------------------------------------- */

export function isPlaceholder(value) {
  return PLACEHOLDER_PATTERN.test(value);
}

/** The collector URL, or null when this copy was never built. */
export function liveSourceUrl() {
  return isPlaceholder(STATS_SOURCE_URL) ? null : STATS_SOURCE_URL;
}

export function fixturesEnabled() {
  return FIXTURES_FLAG === "enabled" || isPlaceholder(FIXTURES_FLAG);
}

/** `?fixture=<name>` when fixtures are enabled and the name is allow-listed. */
export function fixtureNameFromSearch(search, enabled) {
  if (!enabled) {
    return null;
  }
  const name = new URLSearchParams(search).get("fixture");
  return name !== null && FIXTURE_NAMES.includes(name) ? name : null;
}

export function documentAgeMs(doc, nowMs) {
  return nowMs - Date.parse(doc.generated_at);
}

/** Generated within the last 72 hours (a future timestamp counts as fresh). */
export function isFresh(doc, nowMs) {
  return documentAgeMs(doc, nowMs) <= MAX_DOCUMENT_AGE_MS;
}

/**
 * Picks what to render. `live` is the fetch outcome for the collector
 * (`{kind: "ok", doc}`, `{kind: "http", status}`, `{kind: "error"}`, or null
 * when no live source is configured); `snapshot` and `cached` are documents or
 * null. A 404 is the collector saying the public stats are paused, so it wins
 * over every fallback. Otherwise a fresh, valid live document is used as is;
 * failing that, the newest valid copy among live, snapshot, and cache is shown
 * behind a banner; with none, the page says so instead of inventing numbers.
 */
export function resolveStatsSource({ cached = null, live = null, snapshot = null }, nowMs) {
  if (live !== null && live.kind === "http" && live.status === 404) {
    return { doc: null, origin: null, reason: "http-404", state: "paused" };
  }

  let liveProblem;
  if (live === null) {
    liveProblem = "unconfigured";
  } else if (live.kind === "http") {
    liveProblem = `http-${live.status}`;
  } else if (live.kind !== "ok") {
    liveProblem = "unreachable";
  } else if (!validateStats(live.doc).ok) {
    liveProblem = "invalid";
  } else if (!isFresh(live.doc, nowMs)) {
    liveProblem = "stale";
  } else {
    return { doc: live.doc, origin: "live", reason: null, state: "live" };
  }

  const candidates = [];
  if (liveProblem === "stale") {
    candidates.push({ doc: live.doc, origin: "live" });
  }
  if (snapshot !== null && validateStats(snapshot).ok) {
    candidates.push({ doc: snapshot, origin: "snapshot" });
  }
  if (cached !== null && validateStats(cached).ok) {
    candidates.push({ doc: cached, origin: "cache" });
  }
  if (candidates.length === 0) {
    return { doc: null, origin: null, reason: liveProblem, state: "unavailable" };
  }
  candidates.sort(
    (left, right) => Date.parse(right.doc.generated_at) - Date.parse(left.doc.generated_at),
  );
  return { ...candidates[0], reason: liveProblem, state: "fallback" };
}

/** Banner sentence for a `resolveStatsSource` reason. */
export function describeSourceProblem(reason) {
  switch (reason) {
    case "unconfigured":
      return "This build has no live source configured.";
    case "unreachable":
      return "The live source could not be reached.";
    case "stale":
      return "The live source has not published a newer document.";
    case "invalid":
      return "The live source returned a document this page could not read.";
    default:
      return reason !== null && reason.startsWith("http-")
        ? `The live source answered with HTTP ${reason.slice(5)}.`
        : "";
  }
}

/* ----------------------------------------------------------------------------
   Chart geometry. Every chart is an inline SVG on a 720×220 view box (360×200
   on phones, 1080×260 on a full-width card); the helpers below are pure so
   the tests can cover their logic (gaps, windows, view choice), while the
   drawn result is checked by eye on the fixtures.
   ------------------------------------------------------------------------- */

export const VIEW = Object.freeze({
  height: 220,
  plot: Object.freeze({ bottom: 30, left: 48, right: 14, top: 12 }),
  width: 720,
});
// Phones scale a 720-unit view box down so far that 11px axis text becomes
// unreadable; a narrower view box keeps the text near its intended size.
export const COMPACT_VIEW = Object.freeze({
  height: 200,
  plot: Object.freeze({ bottom: 28, left: 42, right: 10, top: 12 }),
  width: 360,
});
export const COMPACT_MAX_WIDTH = 520;
// A card spanning the whole container scales the 720-unit view box up by half,
// which bloats the axis text and the bars; a wider view box keeps both at
// their intended size.
export const WIDE_VIEW = Object.freeze({
  height: 260,
  plot: Object.freeze({ bottom: 30, left: 48, right: 14, top: 12 }),
  width: 1080,
});
export const WIDE_MIN_WIDTH = 900;

/** The view box for a chart container of `containerWidth` CSS pixels (0 = unknown). */
export function chartViewForWidth(containerWidth) {
  if (containerWidth <= 0) {
    return VIEW;
  }
  if (containerWidth < COMPACT_MAX_WIDTH) {
    return COMPACT_VIEW;
  }
  return containerWidth >= WIDE_MIN_WIDTH ? WIDE_VIEW : VIEW;
}

/** "compact", "full", or "wide": the name a chart container is stamped with. */
export function chartViewName(view) {
  if (view === COMPACT_VIEW) {
    return "compact";
  }
  return view === WIDE_VIEW ? "wide" : "full";
}

/** Smallest 1/2/5 × 10^k at or above `max`; 1 when there is nothing to scale. */
export function niceCeiling(max) {
  if (!isNumber(max) || max <= 0) {
    return 1;
  }
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5]) {
    if (step * magnitude >= max) {
      return step * magnitude;
    }
  }
  return 10 * magnitude;
}

export function linearScale(domainStart, domainEnd, rangeStart, rangeEnd) {
  const span = domainEnd - domainStart;
  return (value) =>
    span === 0
      ? (rangeStart + rangeEnd) / 2
      : rangeStart + ((value - domainStart) / span) * (rangeEnd - rangeStart);
}

/** Splits an array of points (null = gap) into runs of consecutive points. */
export function polylineSegments(points) {
  const segments = [];
  let current = [];
  for (const point of points) {
    if (point === null) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
    } else {
      current.push(point);
    }
  }
  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

/** Points, runs, and end marker for a min–max scaled sparkline. */
export function sparklineGeometry(values, { height = 28, pad = 3, width = 120 } = {}) {
  const known = values.filter(isNumber);
  if (known.length === 0) {
    return { end: null, max: null, min: null, points: values.map(() => null), segments: [] };
  }
  const min = Math.min(...known);
  const max = Math.max(...known);
  const xAt = (index) =>
    values.length === 1 ? width / 2 : pad + ((width - 2 * pad) * index) / (values.length - 1);
  const yAt = linearScale(min, max, height - pad, pad);
  const points = values.map((value, index) =>
    isNumber(value) ? { value, x: xAt(index), y: yAt(value) } : null,
  );
  const end = [...points].reverse().find((point) => point !== null) ?? null;
  return { end, max, min, points, segments: polylineSegments(points) };
}

/** Evenly spaced slots with a surface gap and a 24px cap on bar thickness. */
export function barLayout(count, { gap = 2, left, maxBarWidth = 24, width }) {
  const slot = width / Math.max(count, 1);
  const barWidth = Math.max(1, Math.min(maxBarWidth, slot - gap));
  return { barWidth, slot, x: (index) => left + index * slot + (slot - barWidth) / 2 };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/** A bar with a rounded data end and a square baseline end. */
export function roundedTopRectPath(x, y, width, height, radius) {
  if (height <= 0 || width <= 0) {
    return "";
  }
  const r = round2(Math.min(radius, width / 2, height));
  const bottom = round2(y + height);
  return [
    `M${round2(x)},${bottom}`,
    `V${round2(y + r)}`,
    `A${r},${r} 0 0 1 ${round2(x + r)},${round2(y)}`,
    `H${round2(x + width - r)}`,
    `A${r},${r} 0 0 1 ${round2(x + width)},${round2(y + r)}`,
    `V${bottom}`,
    "Z",
  ].join(" ");
}

/** The newest `count` days of every parallel series. */
export function lastDays(timeseries, count) {
  const start = Math.max(0, timeseries.days.length - count);
  const window = { days: timeseries.days.slice(start) };
  for (const series of Object.keys(SERIES_CHECKS)) {
    window[series] = timeseries[series].slice(start);
  }
  return window;
}

/* ----------------------------------------------------------------------------
   Rendering. Everything below touches the DOM and never runs under Node.
   ------------------------------------------------------------------------- */

const SVG_NS = "http://www.w3.org/2000/svg";

function createElement(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  applyAttributes(node, attributes);
  appendChildren(node, children);
  return node;
}

function createSvgElement(tag, attributes = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  applyAttributes(node, attributes);
  appendChildren(node, children);
  return node;
}

function applyAttributes(node, attributes) {
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== null && value !== undefined) {
      node.setAttribute(name, String(value));
    }
  }
}

function appendChildren(node, children) {
  for (const child of Array.isArray(children) ? children : [children]) {
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
}

function clearChildren(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

/* Theme ------------------------------------------------------------------- */

function systemTheme() {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") ?? systemTheme();
}

function wireThemeToggle() {
  const toggle = document.getElementById("theme-toggle");
  if (toggle === null) {
    return;
  }
  const reflect = () => {
    const label = currentTheme() === "dark" ? "Switch to light theme" : "Switch to dark theme";
    toggle.setAttribute("aria-pressed", String(currentTheme() === "dark"));
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("title", label);
  };
  toggle.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage may be blocked; the choice then lasts for this page view.
    }
    reflect();
  });
  if (typeof matchMedia === "function") {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", reflect);
  }
  reflect();
}

/* Try Patch: copy the quickstart ------------------------------------------- */

const COPY_RESET_MS = 2000;

function selectText(node) {
  const selection = window.getSelection();
  if (selection === null) {
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

function wireCopyButton() {
  const button = document.getElementById("copy-quickstart");
  const command = document.getElementById("quickstart-command");
  const status = document.getElementById("copy-status");
  if (button === null || command === null || status === null) {
    return;
  }
  let resetTimer = null;
  button.addEventListener("click", () => {
    const text = command.textContent;
    // The Clipboard API needs a secure context and can still reject (a denied
    // permission, an older browser); selecting the commands then leaves the
    // visitor one keystroke from the same result.
    let write;
    try {
      write = navigator.clipboard.writeText(text);
    } catch (error) {
      write = Promise.reject(error);
    }
    write.then(
      () => {
        // The button label already says it; the status line only announces
        // it to screen readers, and is emptied with the label so a second
        // copy is announced again.
        button.textContent = "Copied";
        status.classList.add("visually-hidden");
        status.textContent = "Copied to the clipboard.";
        clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          button.textContent = "Copy";
          status.textContent = "";
        }, COPY_RESET_MS);
      },
      () => {
        selectText(command);
        status.classList.remove("visually-hidden");
        status.textContent = "The clipboard is not available here. The commands are selected; copy them with Ctrl+C or ⌘C.";
      },
    );
  });
}

/* Analytics --------------------------------------------------------------- */

function initPlausible() {
  if (PLAUSIBLE_FLAG !== "enabled") {
    return;
  }
  // The official queue stub: events wait until the plausible.io script the
  // production build injects into <head> has loaded.
  const plausible =
    window.plausible ||
    function queue() {
      (plausible.q = plausible.q || []).push(arguments);
    };
  window.plausible = plausible;
  plausible.init = plausible.init || ((options) => {
    plausible.o = options || {};
  });
  plausible.init();
}

/* Last good copy ---------------------------------------------------------- */

function readCachedDocument() {
  try {
    const raw = localStorage.getItem(DOCUMENT_STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const doc = JSON.parse(raw);
    return validateStats(doc).ok ? doc : null;
  } catch {
    return null;
  }
}

function saveCachedDocument(doc) {
  try {
    localStorage.setItem(DOCUMENT_STORAGE_KEY, JSON.stringify(doc));
  } catch {
    // Quota or blocked storage: the snapshot remains the fallback.
  }
}

/* Fetching ---------------------------------------------------------------- */

async function fetchLive(url) {
  try {
    const response = await fetch(url, { cache: "no-cache", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      return { kind: "http", status: response.status };
    }
    return { doc: await response.json(), kind: "ok" };
  } catch (error) {
    return { kind: "error", reason: error instanceof Error ? error.message : String(error) };
  }
}

async function fetchOptionalJson(path) {
  try {
    const response = await fetch(path, { signal: AbortSignal.timeout(10_000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/* Shared chart furniture -------------------------------------------------- */

function plotBox(view) {
  const { plot } = view;
  return {
    baseline: view.height - plot.bottom,
    innerHeight: view.height - plot.top - plot.bottom,
    innerWidth: view.width - plot.left - plot.right,
    plot,
  };
}

function chartViewFor(wrap) {
  const view = chartViewForWidth(wrap.clientWidth);
  wrap.dataset.view = chartViewName(view);
  return view;
}

function createChartSvg(view, label) {
  return createSvgElement("svg", {
    "aria-label": label,
    class: "chart-svg",
    role: "img",
    viewBox: `0 0 ${view.width} ${view.height}`,
  });
}

function gridLines(svg, view, values, yAt, labelFor) {
  const { plot } = view;
  values.forEach((value, index) => {
    svg.append(
      createSvgElement("line", {
        class: index === 0 ? "chart-grid chart-grid--base" : "chart-grid",
        x1: plot.left,
        x2: view.width - plot.right,
        y1: round2(yAt(value)),
        y2: round2(yAt(value)),
      }),
      createSvgElement(
        "text",
        { class: "chart-axis-text", "text-anchor": "end", x: plot.left - 8, y: round2(yAt(value) + 3.5) },
        labelFor(value),
      ),
    );
  });
}

function xAxisLabels(svg, view, count, xAt, labelFor) {
  const last = count - 1;
  const indices = [...new Set([0, Math.floor(last / 2), last])];
  for (const index of indices) {
    svg.append(
      createSvgElement(
        "text",
        {
          class: "chart-axis-text",
          "text-anchor": index === 0 ? "start" : index === last ? "end" : "middle",
          x: round2(xAt(index)),
          y: view.height - 10,
        },
        labelFor(index),
      ),
    );
  }
}

function buildTooltip() {
  return createElement("div", { "aria-live": "polite", class: "chart-tooltip", hidden: "" });
}

function fillTooltip(tooltip, title, note, rows) {
  clearChildren(tooltip);
  tooltip.append(createElement("div", { class: "chart-tooltip-title" }, title));
  if (note) {
    tooltip.append(createElement("div", { class: "chart-tooltip-note" }, note));
  }
  for (const row of rows) {
    tooltip.append(
      createElement("div", { class: "chart-tooltip-row" }, [
        createElement("span", { class: "chart-tooltip-label" }, [
          createElement("span", { "aria-hidden": "true", class: `legend-key ${row.swatchClass}` }),
          row.label,
        ]),
        createElement("span", { class: "chart-tooltip-value" }, row.value),
      ]),
    );
  }
}

function placeTooltip(tooltip, viewX, view) {
  const fraction = viewX / view.width;
  if (fraction > 0.5) {
    tooltip.style.left = "auto";
    tooltip.style.right = `${(100 - fraction * 100).toFixed(2)}%`;
  } else {
    tooltip.style.right = "auto";
    tooltip.style.left = `${(fraction * 100).toFixed(2)}%`;
  }
}

/**
 * Pointer and keyboard readout for one chart: the pointer picks the nearest
 * index (the hit target is the whole slot, never the mark), arrow keys step
 * through indices once the chart has focus.
 */
function attachChartHover({ count, indexAt, onChange, svg, view, wrap }) {
  let active = null;
  const update = (index) => {
    const next = index === null ? null : Math.min(count - 1, Math.max(0, index));
    if (next !== active) {
      active = next;
      onChange(active);
    }
  };
  svg.addEventListener("pointermove", (event) => {
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) {
      return;
    }
    update(indexAt(((event.clientX - rect.left) / rect.width) * view.width));
  });
  svg.addEventListener("pointerleave", () => update(null));
  wrap.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (step !== undefined) {
      update(active === null ? (step > 0 ? 0 : count - 1) : active + step);
    } else if (event.key === "Home") {
      update(0);
    } else if (event.key === "End") {
      update(count - 1);
    } else if (event.key === "Escape") {
      update(null);
    } else {
      return;
    }
    event.preventDefault();
  });
  wrap.addEventListener("blur", () => update(null));
}

/* KPI sparkline ----------------------------------------------------------- */

function renderSparkline(svg, values) {
  clearChildren(svg);
  const { end, segments } = sparklineGeometry(values);
  for (const segment of segments) {
    if (segment.length === 1) {
      svg.append(createSvgElement("circle", { class: "spark-dot", cx: round2(segment[0].x), cy: round2(segment[0].y), r: 2.5 }));
    } else {
      svg.append(
        createSvgElement("polyline", {
          class: "spark-line",
          points: segment.map((point) => `${round2(point.x)},${round2(point.y)}`).join(" "),
        }),
      );
    }
  }
  if (end !== null) {
    svg.append(createSvgElement("circle", { class: "spark-end", cx: round2(end.x), cy: round2(end.y), r: 3 }));
  }
  svg.setAttribute(
    "aria-label",
    `Active devices over the last 7 reported days: ${values
      .map((value) => (value === null ? "no data" : formatInteger(value)))
      .join(", ")}`,
  );
  // SVGElement has no `hidden` property, so the attribute is toggled directly.
  svg.removeAttribute("hidden");
}

/* Daily applied bars ------------------------------------------------------- */

function renderDailyChart(wrap, window) {
  clearChildren(wrap);
  const { applied, days } = window;
  const count = days.length;
  const known = applied.filter(isNumber);
  if (count === 0 || known.length === 0) {
    wrap.append(createElement("p", { class: "chart-empty" }, "No reported day in this window."));
    return;
  }

  const view = chartViewFor(wrap);
  const { baseline, innerHeight, innerWidth, plot } = plotBox(view);
  const top = niceCeiling(Math.max(...known));
  const yAt = linearScale(0, top, baseline, plot.top);
  const heightFor = (value) => (innerHeight * value) / top;
  // Ninety slots in a compact view leave no room for a 2-unit gap.
  const layout = barLayout(count, { gap: innerWidth / count < 5 ? 1 : 2, left: plot.left, width: innerWidth });
  const radius = Math.min(4, layout.barWidth / 2);
  const latest = count - 1;
  const svg = createChartSvg(
    view,
    `Updates applied per day, ${formatUtcDate(days[0])} to ${formatUtcDate(days[latest])}. ` +
      `Latest day: ${applied[latest] === null ? "no report" : `${formatInteger(applied[latest])} applied`}. ` +
      `Highest day: ${formatInteger(Math.max(...known))} applied.`,
  );

  gridLines(svg, view, [0, top / 2, top].filter(Number.isInteger), yAt, compactNumber);
  xAxisLabels(svg, view, count, (index) => layout.x(index) + layout.barWidth / 2, (index) => formatShortUtcDate(days[index]));

  const groups = days.map((_, index) => {
    const group = createSvgElement("g", { class: "chart-bar-group" });
    if (applied[index] !== null) {
      const height = heightFor(applied[index]);
      group.append(
        createSvgElement("path", {
          class: "chart-bar chart-bar--applied",
          d: roundedTopRectPath(layout.x(index), baseline - height, layout.barWidth, height, radius),
        }),
      );
    }
    return group;
  });
  svg.append(...groups);

  const tooltip = buildTooltip();
  wrap.append(svg, tooltip);
  let highlighted = null;
  attachChartHover({
    count,
    indexAt: (viewX) => Math.floor((viewX - plot.left) / layout.slot),
    onChange: (index) => {
      if (highlighted !== null) {
        highlighted.classList.remove("is-active");
        highlighted = null;
      }
      if (index === null) {
        tooltip.hidden = true;
        return;
      }
      highlighted = groups[index];
      highlighted.classList.add("is-active");
      fillTooltip(tooltip, formatUtcDate(days[index]), applied[index] === null ? "no report for this day" : "", [
        { label: "Applied", swatchClass: "legend-key--applied", value: formatInteger(applied[index]) },
      ]);
      placeTooltip(tooltip, layout.x(index) + layout.barWidth / 2, view);
      tooltip.hidden = false;
    },
    svg,
    view,
    wrap,
  });
}

/* Weekly releases bars ----------------------------------------------------- */

function describeWeek(week) {
  return `Week ${week.isoWeek}, ${week.isoYear} · ${formatShortUtcDate(week.weekStart)} – ${formatShortUtcDate(week.weekEnd)}`;
}

function renderWeeklyChart(wrap, weeks) {
  clearChildren(wrap);
  const count = weeks.length;
  const known = weeks.map((week) => week.releases).filter(isNumber);
  if (count === 0 || known.length === 0) {
    wrap.append(createElement("p", { class: "chart-empty" }, "No reported week yet."));
    return;
  }

  const view = chartViewFor(wrap);
  const { baseline, innerHeight, innerWidth, plot } = plotBox(view);
  const top = niceCeiling(Math.max(...known));
  const yAt = linearScale(0, top, baseline, plot.top);
  const heightFor = (value) => (innerHeight * value) / top;
  const layout = barLayout(count, { left: plot.left, width: innerWidth });
  const radius = Math.min(4, layout.barWidth / 2);
  const latest = weeks[count - 1];
  const latestReleases =
    latest.releases === null
      ? "no report"
      : `${formatInteger(latest.releases)} ${latest.releases === 1 ? "release" : "releases"}`;
  const svg = createChartSvg(
    view,
    `Releases per ISO week, ${formatUtcDate(weeks[0].weekStart)} to ${formatUtcDate(latest.weekEnd)}. ` +
      `Latest week, ${describeWeek(latest)}: ${latestReleases}` +
      `${latest.partial ? ` (partial, ${latest.coveredDays} of 7 days reported)` : ""}.`,
  );

  gridLines(svg, view, [0, top / 2, top].filter(Number.isInteger), yAt, compactNumber);
  xAxisLabels(svg, view, count, (index) => layout.x(index) + layout.barWidth / 2, (index) => formatShortUtcDate(weeks[index].weekStart));

  const groups = weeks.map((week, index) => {
    const group = createSvgElement("g", { class: "chart-bar-group" });
    if (isNumber(week.releases) && week.releases > 0) {
      const height = heightFor(week.releases);
      group.append(
        createSvgElement("path", {
          class: `chart-bar chart-bar--releases${week.partial ? " chart-bar--partial" : ""}`,
          d: roundedTopRectPath(layout.x(index), baseline - height, layout.barWidth, height, radius),
        }),
      );
    }
    return group;
  });
  svg.append(...groups);

  const tooltip = buildTooltip();
  wrap.append(svg, tooltip);
  let highlighted = null;
  attachChartHover({
    count,
    indexAt: (viewX) => Math.floor((viewX - plot.left) / layout.slot),
    onChange: (index) => {
      if (highlighted !== null) {
        highlighted.classList.remove("is-active");
        highlighted = null;
      }
      if (index === null) {
        tooltip.hidden = true;
        return;
      }
      const week = weeks[index];
      highlighted = groups[index];
      highlighted.classList.add("is-active");
      fillTooltip(tooltip, describeWeek(week), week.partial ? `partial: ${week.coveredDays} of 7 days reported` : "", [
        { label: "Releases", swatchClass: "legend-key--releases", value: formatInteger(week.releases) },
      ]);
      placeTooltip(tooltip, layout.x(index) + layout.barWidth / 2, view);
      tooltip.hidden = false;
    },
    svg,
    view,
    wrap,
  });
}

/* Page sections ----------------------------------------------------------- */

function setKpi(name, value, meta) {
  const tile = document.querySelector(`[data-kpi="${name}"]`);
  if (tile === null) {
    return;
  }
  tile.querySelector(".kpi-value").textContent = value;
  tile.querySelector(".kpi-meta-text").textContent = meta;
}

function renderEmptyTiles(meta) {
  for (const name of ["devices", "teams", "self-hosted"]) {
    setKpi(name, EM_DASH, meta);
  }
  const sparkline = document.getElementById("devices-sparkline");
  if (sparkline !== null) {
    sparkline.setAttribute("hidden", "");
  }
}

function renderTiles(doc) {
  const { totals } = doc;
  const devices = totals.active_devices;
  if (devices === null) {
    setKpi("devices", EM_DASH, "no reported day yet");
    document.getElementById("devices-sparkline").setAttribute("hidden", "");
  } else {
    setKpi("devices", formatInteger(devices.value), `on ${formatUtcDate(devices.day)}`);
    renderSparkline(document.getElementById("devices-sparkline"), devices.last_7_days);
  }

  const { teams } = totals;
  setKpi(
    "teams",
    formatInteger(teams.value),
    `${formatInteger(teams.managed_teams_with_app)} managed · ${formatInteger(teams.self_hosted_servers_30d)} self-hosted`,
  );
  setKpi("self-hosted", formatInteger(totals.self_hosted_servers_30d.value), "last 30 days");
}

function showChartsState(message) {
  const state = document.getElementById("charts-state");
  state.hidden = false;
  state.querySelector("p").textContent = message;
  for (const id of ["updates", "velocity"]) {
    document.getElementById(id).hidden = true;
  }
}

function showCharts() {
  document.getElementById("charts-state").hidden = true;
  for (const id of ["updates", "velocity"]) {
    document.getElementById(id).hidden = false;
  }
}

const CHART_WRAP_IDS = ["daily-chart", "weekly-chart"];
// The last rendered document, kept so a resize across a view-box breakpoint
// can redraw the charts with the other view box.
let renderedDoc = null;

function rerenderChartsOnResize() {
  if (renderedDoc === null || isWarming(renderedDoc)) {
    return;
  }
  const crossed = CHART_WRAP_IDS.some((id) => {
    const wrap = document.getElementById(id);
    return wrap.dataset.view !== chartViewName(chartViewForWidth(wrap.clientWidth));
  });
  if (crossed) {
    renderCharts(renderedDoc);
  }
}

function renderCharts(doc) {
  renderDailyChart(document.getElementById("daily-chart"), lastDays(doc.timeseries, CHART_DAYS));
  renderWeeklyChart(
    document.getElementById("weekly-chart"),
    bucketWeeks(doc.timeseries.days, doc.timeseries.releases, WEEK_BUCKETS),
  );
}

function renderDocument(doc) {
  renderedDoc = doc;
  if (isWarming(doc)) {
    renderEmptyTiles("no reports yet");
    showChartsState("Charts appear after two days of reports.");
    return;
  }
  renderTiles(doc);
  showCharts();
  renderCharts(doc);
}

function showBanner(tone, message) {
  const banner = document.getElementById("page-banner");
  banner.className = `banner banner--${tone}`;
  banner.textContent = message;
  banner.hidden = false;
}

function hideBanner() {
  document.getElementById("page-banner").hidden = true;
}

function renderResolution(resolution) {
  document.documentElement.setAttribute("data-state", resolution.state);
  switch (resolution.state) {
    case "live":
      hideBanner();
      renderDocument(resolution.doc);
      return;
    case "fallback":
      showBanner(
        "warn",
        `Showing data generated ${formatUtcDateTime(resolution.doc.generated_at)}. ${describeSourceProblem(resolution.reason)}`,
      );
      renderDocument(resolution.doc);
      return;
    case "paused":
      showBanner("muted", "Public stats are paused.");
      renderEmptyTiles("paused");
      showChartsState("Public stats are paused.");
      return;
    default:
      showBanner("danger", `Stats are temporarily unavailable. ${describeSourceProblem(resolution.reason)}`);
      renderEmptyTiles("unavailable");
      showChartsState("Stats are temporarily unavailable.");
  }
}

async function loadResolution() {
  const fixtureName = fixtureNameFromSearch(window.location.search, fixturesEnabled());
  if (fixtureName !== null) {
    // Fixture runs never touch the last-good cache: a visitor must not see
    // synthetic numbers behind the fallback banner later.
    const [live, snapshot] = await Promise.all([
      fetchLive(`fixtures/${fixtureName}.json`),
      fetchOptionalJson(SNAPSHOT_PATH),
    ]);
    return { fixtureName, resolution: resolveStatsSource({ live, snapshot }, Date.parse(FIXTURE_CLOCK_ISO)) };
  }
  const url = liveSourceUrl();
  const [live, snapshot] = await Promise.all([
    url === null ? Promise.resolve(null) : fetchLive(url),
    fetchOptionalJson(SNAPSHOT_PATH),
  ]);
  const resolution = resolveStatsSource({ cached: readCachedDocument(), live, snapshot }, Date.now());
  if (resolution.state === "live") {
    saveCachedDocument(resolution.doc);
  }
  return { fixtureName, resolution };
}

async function bootstrap() {
  wireThemeToggle();
  wireCopyButton();
  initPlausible();
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(rerenderChartsOnResize, 150);
  });
  try {
    const { fixtureName, resolution } = await loadResolution();
    document.documentElement.dataset.fixture = fixtureName ?? "";
    renderResolution(resolution);
  } catch (error) {
    console.error(error);
    renderResolution({ doc: null, origin: null, reason: "render-error", state: "unavailable" });
  }
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  // boot.js reports a page whose module never ran; this stamp tells it apart
  // from a slow fetch.
  document.documentElement.setAttribute("data-state", "loading");
  bootstrap();
}
