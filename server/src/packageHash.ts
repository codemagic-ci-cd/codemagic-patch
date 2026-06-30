import { readBundleTreeFromZipBuffer } from "./worker/bundleTree";

export function computePackageHashFromZipBuffer(zipBuffer: Buffer | Uint8Array): string {
  return readBundleTreeFromZipBuffer(zipBuffer).packageHash;
}
