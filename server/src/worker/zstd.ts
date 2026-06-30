import { Buffer } from "node:buffer";
import { compress, decompress } from "zstd-napi";

export function zstdCompressSync(input: Buffer | Uint8Array): Buffer {
  return compress(input instanceof Buffer ? input : Buffer.from(input));
}

export function zstdDecompressSync(input: Buffer | Uint8Array): Buffer {
  return decompress(input instanceof Buffer ? input : Buffer.from(input));
}
