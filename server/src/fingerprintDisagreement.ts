export interface FingerprintDisagreement {
  binaryVersion: string;
  storedFingerprint: string;
  releaseFingerprint: string;
}

export function fingerprintDisagreementDetail(
  disagreement: FingerprintDisagreement,
): string {
  const truncate = (value: string): string =>
    value.length > 12 ? `${value.slice(0, 12)}…` : value;

  return (
    `release fingerprint ${truncate(disagreement.releaseFingerprint)} differs from the fingerprint ` +
    `${truncate(disagreement.storedFingerprint)} recorded for binary version ` +
    `${disagreement.binaryVersion} in this deployment; devices on this binary version may be ` +
    "native-incompatible with this update"
  );
}
