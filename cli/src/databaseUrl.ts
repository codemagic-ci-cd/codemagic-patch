/**
 * A Postgres URL the install can store and check.
 *
 * Providers show either one connection string or the same facts on separate
 * lines. Both are reduced to the same six fields, and the stored string is
 * built back from those fields: nothing the user pasted reaches the env file
 * as written, so a fragment, a stray `?&`, or an odd spelling of the scheme
 * cannot make the server read a different connection from the one the probe
 * checked.
 *
 * `sslmode=verify-full` and `sslrootcert` are refused: those strings point at
 * a certificate file on the laptop, and the server has no such file.
 * `sslmode=require` is what DigitalOcean, RDS, and Cloud SQL mean by "encrypt",
 * and it is the only mode accepted: with `prefer`, psql (the probe) falls back
 * to plaintext on a database without TLS while pg does not, so the probe would
 * pass a connection the server then fails.
 *
 * The user and password are read and written the way pg reads them
 * (`decodeURIComponent`); the database name the way pg reads it (`decodeURI`,
 * which leaves `; / ? : @ & = + $ , #` escapes alone). Each pair is an
 * inverse, so the probe and the server name the same database.
 *
 * The stored string adds `uselibpqcompat=true`. pg 8 otherwise reads `require`
 * as `verify-full`, which rejects the certificates managed providers use; the
 * switch gives it the libpq meaning the probe (psql) already applies. Only the
 * string this wizard writes carries it, so a hand-written DATABASE_URL keeps
 * the server's default behavior.
 */

export type DatabaseTarget = {
  database: string;
  host: string;
  password: string;
  port: string;
  sslmode: "require";
  /** The string install.sh records as DATABASE_URL, built from the other fields. */
  url: string;
  user: string;
};

type DatabaseFields = Omit<DatabaseTarget, "url">;

const NEEDS_FIELDS =
  "That needs a host, a port, a database name, a user, and a password. A connection string or those fields on separate lines both work.";

const CERTIFICATE =
  "That string verifies the database certificate. Turn certificate verification off in your provider's connection screen and copy the string that ends in sslmode=require.";

const BROKEN_ESCAPE =
  "A % in the user, password, or database name has to be written as %25.";

const IPV6_HOST =
  "An IPv6 address cannot be the host. Use the hostname your provider shows.";

const HOST_SHAPE = "The host has to be a hostname or an IPv4 address.";

const FRAGMENT =
  "The connection string cannot contain a #. A # in the password has to be written as %23.";

const DATABASE_NAME = "The database name cannot contain /, ?, or #.";

const ONLY_SSLMODE =
  "The connection string can only have sslmode after the ?. Remove the other settings and paste it again.";

const REQUIRE_SSLMODE = "The connection has to use sslmode=require.";

export function parseDatabaseInput(value: string): DatabaseTarget | string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "Paste the connection string.";
  if (trimmed.includes("\0")) return NEEDS_FIELDS;
  if (/^postgres(?:ql)?:\/\//iu.test(trimmed)) return parseUrl(trimmed);
  if (trimmed.includes("=") || trimmed.includes(":")) return parseFields(trimmed);
  return NEEDS_FIELDS;
}

function parseUrl(value: string): DatabaseTarget | string {
  // Checked on the raw string: `new URL` keeps a fragment out of the query,
  // and a `#` here is almost always an unencoded character in the password.
  if (value.includes("#")) return FRAGMENT;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return NEEDS_FIELDS;
  }
  const user = percentDecoded(url.username);
  const password = percentDecoded(url.password);
  const host = url.hostname;
  const port = url.port;
  const database = databaseDecoded(url.pathname.replace(/^\//u, ""));
  if (user === undefined || password === undefined || database === undefined) {
    return BROKEN_ESCAPE;
  }
  if (!user || !password || !host || !port || !database) return NEEDS_FIELDS;
  const hostProblem = describeHostProblem(host);
  if (hostProblem !== null) return hostProblem;
  const databaseProblem = describeDatabaseNameProblem(database);
  if (databaseProblem !== null) return databaseProblem;
  const queryProblem = describeQueryProblem(url.searchParams);
  if (queryProblem !== null) return queryProblem;
  const sslProblem = describeSslModeProblem(url.searchParams.get("sslmode") ?? undefined);
  if (sslProblem !== null) return sslProblem;
  return withStoredUrl({ database, host, password, port, sslmode: "require", user });
}

const PG_LIBPQ_COMPAT = "uselibpqcompat=true";

/**
 * The one place the stored string is written. Every field is encoded, so the
 * result never contains a single quote (install.sh stores it single-quoted)
 * and reads back to the same fields through pg-connection-string.
 */
export function storedDatabaseUrl(fields: DatabaseFields): string {
  return `postgresql://${encodeComponent(fields.user)}:${encodeComponent(fields.password)}@${fields.host}:${fields.port}/${encodeDatabase(fields.database)}?sslmode=${fields.sslmode}&${PG_LIBPQ_COMPAT}`;
}

function withStoredUrl(fields: DatabaseFields): DatabaseTarget {
  return { ...fields, url: storedDatabaseUrl(fields) };
}

/** `encodeURIComponent` leaves `'` alone, and that is the one character the env file cannot hold. */
function encodeComponent(value: string): string {
  return encodeURIComponent(value).replaceAll("'", "%27");
}

/**
 * The inverse of pg's `decodeURI`: reserved characters stay literal, since an
 * escape of one would stay an escape on the server. `/`, `?`, and `#` are
 * refused before this, because they would end the path instead.
 */
function encodeDatabase(value: string): string {
  return encodeURI(value).replaceAll("'", "%27");
}

function describeDatabaseNameProblem(database: string): string | null {
  return /[/?#]/u.test(database) ? DATABASE_NAME : null;
}

/**
 * A bracketed host is an IPv6 literal, which pg keeps bracketed and cannot
 * connect to. Anything else has to be a hostname or an IPv4 address: psql
 * receives it as PGHOST, and the stored string repeats it unencoded.
 */
function describeHostProblem(host: string): string | null {
  if (host.startsWith("[") || host.includes(":")) return IPV6_HOST;
  return /^[A-Za-z0-9.-]+$/u.test(host) ? null : HOST_SHAPE;
}

/**
 * Only `sslmode` may follow the `?`. The probe connects from six extracted
 * fields, so any other setting (`options=-csearch_path`, a CA file, a pg
 * switch) would make it check a different connection from the one the server
 * opens with the stored string.
 */
function describeQueryProblem(params: URLSearchParams): string | null {
  for (const key of params.keys()) {
    if (key === "sslrootcert") return CERTIFICATE;
    if (key !== "sslmode") return ONLY_SSLMODE;
  }
  return params.getAll("sslmode").length > 1 ? ONLY_SSLMODE : null;
}

/**
 * `prefer` is refused with the rest: psql would fall back to plaintext on a
 * database without TLS and pass the probe, while pg treats it as `require`
 * and fails to start.
 */
function describeSslModeProblem(sslmode: string | undefined): string | null {
  if (sslmode === undefined || sslmode === "require") return null;
  if (sslmode === "verify-full" || sslmode === "verify-ca") return CERTIFICATE;
  return REQUIRE_SSLMODE;
}

/** `new URL` keeps a broken `%` sequence. `decodeURIComponent` throws on it. */
function percentDecoded(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** The database name as pg reads it from the path. */
function databaseDecoded(value: string): string | undefined {
  try {
    return decodeURI(value);
  } catch {
    return undefined;
  }
}

function parseFields(value: string): DatabaseTarget | string {
  const fields = new Map<string, string>();
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(username|user|password|host|port|database|dbname|sslmode)\s*[=:]\s*(.*)$/iu.exec(trimmed);
    if (match === null) {
      return "Each line should be a name and a value, such as host = db.example.com.";
    }
    fields.set(match[1]!.toLowerCase(), match[2]!.trim());
  }
  const user = fields.get("username") ?? fields.get("user") ?? "";
  const password = fields.get("password") ?? "";
  const host = fields.get("host") ?? "";
  const port = fields.get("port") ?? "";
  const database = fields.get("database") ?? fields.get("dbname") ?? "";
  const sslmode = fields.get("sslmode");
  if (!user || !password || !host || !port || !database) return NEEDS_FIELDS;
  const hostProblem = describeHostProblem(host);
  if (hostProblem !== null) return hostProblem;
  if (!/^\d+$/u.test(port)) return "The port has to be a number.";
  const databaseProblem = describeDatabaseNameProblem(database);
  if (databaseProblem !== null) return databaseProblem;
  const sslProblem = describeSslModeProblem(sslmode);
  if (sslProblem !== null) return sslProblem;
  return withStoredUrl({ database, host, password, port, sslmode: "require", user });
}

/** Drop the password from a probe log. The encoded form can appear in a URL echo. */
export function redactDatabaseSecret(output: string, password: string): string {
  if (password.length === 0) return output;
  return output
    .replaceAll(password, "***")
    .replaceAll(encodeComponent(password), "***");
}

/** Docker could not run the probe at all: said before any psql reading of the output. */
export function describeDockerProblem(output: string): string | null {
  const text = output.toLowerCase();
  return text.includes("docker:") || text.includes("docker daemon")
    ? "Docker on the server could not run the connection check."
    : null;
}

export function summarizeDatabaseProbe(output: string, password: string): string {
  const cleaned = redactDatabaseSecret(output, password);
  const docker = describeDockerProblem(cleaned);
  if (docker !== null) return docker;
  const text = cleaned.toLowerCase();
  if (text.includes("password authentication failed") || text.includes("authentication failed")) {
    return "The database rejected that user or password.";
  }
  if (text.includes("certificate") || text.includes("ssl error") || text.includes("ssl syscall")) {
    return "The server reached the database, but the certificate check failed. Copy the connection string that ends in sslmode=require.";
  }
  if (
    text.includes("timeout") ||
    text.includes("connection refused") ||
    text.includes("could not connect") ||
    text.includes("no route to host")
  ) {
    return "The server could not open a connection. Its IP is probably not allowed yet.";
  }
  const line = cleaned
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(-2)
    .join(" ");
  return line.slice(0, 300) || "The connection check failed.";
}
