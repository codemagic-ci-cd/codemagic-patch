// ---------------------------------------------------------------------------
// MD5 — inline implementation for rollout hash (no external dependency)
// Based on RFC 1321. Only used for deterministic rollout stickiness.
// ---------------------------------------------------------------------------

function md5(input: string): string {
  const bytes = encodeUtf8(input);
  const padded = padMessage(bytes);
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];

  for (let i = 0; i < padded.length; i += 64) {
    const M = new Uint32Array(16);

    for (let j = 0; j < 16; j++) {
      M[j] =
        padded[i + j * 4] |
        (padded[i + j * 4 + 1] << 8) |
        (padded[i + j * 4 + 2] << 16) |
        (padded[i + j * 4 + 3] << 24);
    }

    let [A, B, C, D] = [a0, b0, c0, d0];

    for (let j = 0; j < 64; j++) {
      let F: number, g: number;

      if (j < 16) {
        F = (B & C) | (~B & D);
        g = j;
      } else if (j < 32) {
        F = (D & B) | (~D & C);
        g = (5 * j + 1) % 16;
      } else if (j < 48) {
        F = B ^ C ^ D;
        g = (3 * j + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * j) % 16;
      }

      F = (F + A + K[j] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << S[j]) | (F >>> (32 - S[j])))) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  return toHex(a0) + toHex(b0) + toHex(c0) + toHex(d0);
}

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4,
  11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6,
  10, 15, 21,
];

const K = new Uint32Array(
  Array.from({ length: 64 }, (_, i) =>
    Math.floor(2 ** 32 * Math.abs(Math.sin(i + 1))),
  ),
);

function encodeUtf8(str: string): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(str);
}

function padMessage(bytes: Uint8Array): Uint8Array {
  const bitLen = bytes.length * 8;
  const padLen = ((56 - ((bytes.length + 1) % 64) + 64) % 64) + 1;
  const padded = new Uint8Array(bytes.length + padLen + 8);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  // Append original length in bits as 64-bit little-endian
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLen >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLen / 2 ** 32), true);
  return padded;
}

function toHex(n: number): string {
  return Array.from({ length: 4 }, (_, i) =>
    ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, "0"),
  ).join("");
}

// ---------------------------------------------------------------------------
// Rollout hash
// ---------------------------------------------------------------------------

/**
 * Deterministic rollout hash: md5(deviceId + "-" + releaseLabel) % 100.
 * Same input always produces the same bucket (0-99).
 */
export function computeRolloutHash(
  deviceId: string,
  releaseLabel: string,
): number {
  const hash = md5(`${deviceId}-${releaseLabel}`);
  // Parse first 8 hex chars as unsigned 32-bit integer
  const value = parseInt(hash.substring(0, 8), 16);
  return value % 100;
}
