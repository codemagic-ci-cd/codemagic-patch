/**
 * Which server a `selfhost` command acts on, and where its key lives.
 *
 * The config maps a normalized server URL to an ssh target, but the two are
 * not interchangeable and the asymmetry is deliberate: the URL exists only
 * after an install succeeds, so anything written *during* an install — the key
 * file, the pending-install record — is keyed by the ssh host instead.
 */

import { join } from "node:path";

import type {
  CliConfig,
  SelfhostMapping,
  SelfhostPendingInstall,
} from "./configStore";
import { normalizeServerUrl } from "./credentialStore";
import { resolveConfigHome } from "./configStore";

export type SelfhostTarget = SelfhostMapping & {
  /** The URL this pairing is stored under, once one exists. */
  serverUrl?: string;
};

export type SelfhostTargetResolution =
  | {
      kind: "ambiguous";
      serverUrls: string[];
    }
  | {
      kind: "resolved";
      source: "argument" | "server-url" | "sole-mapping";
      target: SelfhostTarget;
    }
  | { kind: "unpaired" };

/**
 * The config key and key-file name for a host.
 *
 * `user@` is dropped on purpose: the key belongs to the machine, and a user
 * who first paired as `root@` and later as `ubuntu@` is talking to the same
 * server and should reuse the same key. Everything outside a conservative
 * character set becomes `-` because this value is also a filename — an IPv6
 * literal's colons and brackets would otherwise produce a path no Windows
 * filesystem accepts.
 */
export function normalizeSshHost(sshTarget: string): string {
  const withoutUser = sshTarget.includes("@")
    ? sshTarget.slice(sshTarget.lastIndexOf("@") + 1)
    : sshTarget;

  return withoutUser
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9.-]/gu, "-")
    .replaceAll(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/**
 * Where the CLI's own key for a host lives. Under the config directory rather
 * than `~/.ssh`, so the CLI never writes into the user's own SSH setup — which
 * it treats as a bootstrap channel it may read but must not own.
 */
export function resolveSelfhostKeyPath(
  env: Record<string, string | undefined>,
  sshTarget: string,
): string {
  return join(resolveConfigHome(env), "keys", normalizeSshHost(sshTarget));
}

export function resolveSelfhostTarget(input: {
  config: CliConfig;
  /** The `user@vps` argument, which always wins. */
  explicitTarget?: string;
  /** The effective server URL, from env/config/project. */
  serverUrl?: string;
}): SelfhostTargetResolution {
  const mappings = input.config.selfhost ?? {};

  if (input.explicitTarget !== undefined) {
    const sshTarget = input.explicitTarget.trim();
    // An explicit target still picks up a recorded key and remote path when it
    // names a host already paired — otherwise passing `user@vps` to a paired
    // server would silently fall back to the user's own SSH setup.
    const known = Object.entries(mappings).find(
      ([, mapping]) =>
        normalizeSshHost(mapping.sshTarget) === normalizeSshHost(sshTarget),
    );

    return {
      kind: "resolved",
      source: "argument",
      target:
        known === undefined
          ? { sshTarget }
          : { ...known[1], serverUrl: known[0], sshTarget },
    };
  }

  if (input.serverUrl !== undefined) {
    const key = safeNormalizeServerUrl(input.serverUrl);
    const mapping = key === undefined ? undefined : mappings[key];
    if (mapping !== undefined && key !== undefined) {
      return {
        kind: "resolved",
        source: "server-url",
        target: { ...mapping, serverUrl: key },
      };
    }

    // A server URL is active but unpaired. Falling back to another mapping
    // here would run a destructive command against a server the user did not
    // name, so this is the unpaired path even when other mappings exist.
    return { kind: "unpaired" };
  }

  const entries = Object.entries(mappings);
  if (entries.length === 0) {
    return { kind: "unpaired" };
  }

  if (entries.length > 1) {
    return { kind: "ambiguous", serverUrls: entries.map(([url]) => url).sort() };
  }

  const [serverUrl, mapping] = entries[0] as [string, SelfhostMapping];
  return {
    kind: "resolved",
    source: "sole-mapping",
    target: { ...mapping, serverUrl },
  };
}

/** The config key a pairing for this server URL is stored under. */
export function selfhostMappingKey(serverUrl: string): string {
  return safeNormalizeServerUrl(serverUrl) ?? serverUrl;
}

export function withSelfhostMapping(
  config: CliConfig,
  serverUrl: string,
  mapping: SelfhostMapping,
): CliConfig {
  const key = selfhostMappingKey(serverUrl);
  // Merged over the existing entry rather than replacing it: an entry may
  // carry fields this CLI version does not know (written by a newer one), and
  // re-pairing must not strip them.
  const existing = config.selfhost?.[key];

  return {
    ...config,
    selfhost: { ...(config.selfhost ?? {}), [key]: { ...existing, ...mapping } },
  };
}

export function withPendingInstall(
  config: CliConfig,
  sshTarget: string,
  record: SelfhostPendingInstall,
): CliConfig {
  return {
    ...config,
    pendingInstall: {
      ...(config.pendingInstall ?? {}),
      [normalizeSshHost(sshTarget)]: record,
    },
  };
}

export function withoutPendingInstall(
  config: CliConfig,
  sshTarget: string,
): CliConfig {
  const rest = { ...(config.pendingInstall ?? {}) };
  delete rest[normalizeSshHost(sshTarget)];

  return { ...config, pendingInstall: rest };
}

export function readPendingInstall(
  config: CliConfig,
  sshTarget: string,
): SelfhostPendingInstall | undefined {
  return config.pendingInstall?.[normalizeSshHost(sshTarget)];
}

/**
 * `normalizeServerUrl` throws on anything `new URL` rejects. A config file can
 * hold such a value (hand-edited, or written by a future version), and a
 * lookup is not the place to take the CLI down over it.
 */
function safeNormalizeServerUrl(serverUrl: string): string | undefined {
  try {
    return normalizeServerUrl(serverUrl);
  } catch {
    return undefined;
  }
}
