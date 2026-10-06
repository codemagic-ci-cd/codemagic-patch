// The credential store as the rest of this CLI uses it: credentialStore.ts with one
// thing added around it. An unreadable store surfaces there as a bare SyntaxError, or as
// "Invalid credential store file", and stops every command that would authenticate with
// it. So every failure to read it is turned into a message that names the file and says
// what to do. Nothing is ever deleted or overwritten on the user's behalf: a store this
// version cannot read may be one a newer cmpatch-capacitor reads perfectly well.

import { CLI_NAME } from "./branding";
import {
  loadStoredCredential as loadRaw,
  removeStoredCredential as removeRaw,
  resolveCredentialStorePath,
  saveStoredCredential as saveRaw,
  type CredentialStoreOptions,
  type StoredCredential,
} from "./credentialStore";
import { ValidationError } from "./errors";

export type {
  OAuthStoredCredential,
  StoredCredential,
} from "./credentialStore";

export async function loadStoredCredential(
  serverUrl: string,
  options: CredentialStoreOptions = {},
): Promise<StoredCredential | null> {
  return explainingStoreFailures(options, () => loadRaw(serverUrl, options));
}

export async function saveStoredCredential(
  serverUrl: string,
  credential: StoredCredential,
  options: CredentialStoreOptions = {},
): Promise<void> {
  return explainingStoreFailures(options, () => saveRaw(serverUrl, credential, options));
}

export async function removeStoredCredential(
  serverUrl: string,
  options: CredentialStoreOptions = {},
): Promise<void> {
  return explainingStoreFailures(options, () => removeRaw(serverUrl, options));
}

async function explainingStoreFailures<T>(
  options: CredentialStoreOptions,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const storePath = resolveCredentialStorePath(options.env);
    const remedy =
      `Delete ${storePath} and sign in again (that signs you out of every server), ` +
      `or authenticate this run with --token / CODEMAGIC_PATCH_TOKEN, which never reads the store.`;

    if (error instanceof SyntaxError) {
      throw new ValidationError(
        `The credential store ${storePath} is not valid JSON (${error.message}).\n${remedy}`,
      );
    }

    if (error instanceof Error && error.message.startsWith("Invalid credential store file")) {
      throw new ValidationError(
        `The credential store ${storePath} is not in the format this version of ${CLI_NAME} reads (version 1) — a newer ${CLI_NAME} may have written it.\n` +
          `Upgrade ${CLI_NAME}. Failing that: ${remedy.charAt(0).toLowerCase()}${remedy.slice(1)}`,
      );
    }

    throw error;
  }
}
