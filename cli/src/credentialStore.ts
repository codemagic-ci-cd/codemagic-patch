import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface StoredUser {
  displayName: string | null;
  email: string;
  id: string;
}

export interface OAuthStoredCredential {
  accessToken: string;
  accessTokenExpiresAt: string;
  kind: "oauth";
  refreshToken: string;
  refreshTokenExpiresAt: string;
  user: StoredUser;
}

export interface TokenStoredCredential {
  accessToken: string;
  kind: "token";
  user: StoredUser;
}

export type StoredCredential = OAuthStoredCredential | TokenStoredCredential;

// Credentials written before token logins existed have no `kind` discriminator.
// They are always OAuth-shaped, so the on-disk format is a stored credential that
// may also be a legacy OAuth credential missing `kind`. Reads normalize it back
// into a discriminated `StoredCredential`.
type LegacyOAuthStoredCredential = Omit<OAuthStoredCredential, "kind">;
type RawStoredCredential = StoredCredential | LegacyOAuthStoredCredential;

interface CredentialStoreFile {
  servers: Record<string, RawStoredCredential>;
  version: 1;
}

export interface CredentialStoreOptions {
  env?: Record<string, string | undefined>;
}

export function normalizeServerUrl(serverUrl: string): string {
  const url = new URL(serverUrl.trim());
  url.hash = "";
  url.search = "";

  return url.toString().replace(/\/+$/, "");
}

export function resolveCredentialStorePath(
  env: Record<string, string | undefined> = process.env,
): string {
  const codemagicPatchHome = resolveOptionalString(env.CODEMAGIC_PATCH_HOME);
  const home = codemagicPatchHome ?? join(resolveOptionalString(env.HOME) ?? homedir(), ".codemagic-patch");

  return join(home, "credentials.json");
}

export async function loadStoredCredential(
  serverUrl: string,
  options: CredentialStoreOptions = {},
): Promise<StoredCredential | null> {
  const store = await readCredentialStore(options);
  const stored = store.servers[normalizeServerUrl(serverUrl)];
  return stored ? normalizeStoredCredential(stored) : null;
}

function normalizeStoredCredential(
  credential: RawStoredCredential,
): StoredCredential {
  if ("kind" in credential) {
    return credential;
  }

  return {
    ...credential,
    kind: "oauth",
  };
}

export async function saveStoredCredential(
  serverUrl: string,
  credential: StoredCredential,
  options: CredentialStoreOptions = {},
): Promise<void> {
  const store = await readCredentialStore(options);
  store.servers[normalizeServerUrl(serverUrl)] = credential;
  await writeCredentialStore(store, options);
}

export async function removeStoredCredential(
  serverUrl: string,
  options: CredentialStoreOptions = {},
): Promise<void> {
  const store = await readCredentialStore(options);
  delete store.servers[normalizeServerUrl(serverUrl)];
  await writeCredentialStore(store, options);
}

async function readCredentialStore(
  options: CredentialStoreOptions,
): Promise<CredentialStoreFile> {
  const path = resolveCredentialStorePath(options.env);

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        servers: {},
        version: 1,
      };
    }

    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isCredentialStoreFile(parsed)) {
    throw new Error(`Invalid credential store file: ${path}`);
  }

  return parsed;
}

async function writeCredentialStore(
  store: CredentialStoreFile,
  options: CredentialStoreOptions,
): Promise<void> {
  const path = resolveCredentialStorePath(options.env);
  await mkdir(dirname(path), {
    mode: 0o700,
    recursive: true,
  });

  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(tempPath, path);
}

function isCredentialStoreFile(value: unknown): value is CredentialStoreFile {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1 &&
    "servers" in value &&
    typeof value.servers === "object" &&
    value.servers !== null &&
    !Array.isArray(value.servers)
  );
}

function resolveOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isNodeError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  );
}
