// Copied from cli/src/credentialStore.ts (@codemagic/patch-cli 0.4.0), with two
// differences. The file: `cmpatch` keeps its sign-ins in credentials.json; this CLI keeps
// its own in credentials-capacitor.json, in the same directory (~/.codemagic-patch, or
// $CODEMAGIC_PATCH_HOME). The two CLIs never read or write each other's file, so signing
// in or out with one leaves the other as it was, and neither can break the other's
// store. And no reading of an OAuth credential that lacks a `kind`: `cmpatch` wrote those
// before it had token logins, and only into its own file, so this one has never held
// one. See cli-capacitor-tech-spec › Provenance.

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

interface CredentialStoreFile {
  servers: Record<string, StoredCredential>;
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

/** Not `credentials.json`: that one is `cmpatch`'s. */
export const CREDENTIAL_STORE_FILE_NAME = "credentials-capacitor.json";

export function resolveCredentialStorePath(
  env: Record<string, string | undefined> = process.env,
): string {
  const codemagicPatchHome = resolveOptionalString(env.CODEMAGIC_PATCH_HOME);
  const home = codemagicPatchHome ?? join(resolveOptionalString(env.HOME) ?? homedir(), ".codemagic-patch");

  return join(home, CREDENTIAL_STORE_FILE_NAME);
}

export async function loadStoredCredential(
  serverUrl: string,
  options: CredentialStoreOptions = {},
): Promise<StoredCredential | null> {
  const store = await readCredentialStore(options);
  return store.servers[normalizeServerUrl(serverUrl)] ?? null;
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
