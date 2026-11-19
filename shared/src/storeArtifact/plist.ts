import { parseBuffer } from "bplist-parser";
import { parse as parseXmlPlist } from "plist";

/** Store artifacts accept binary and XML plists; OpenStep is not a supported format. */
export function parsePlist(bytes: Uint8Array): unknown {
  if (Buffer.from(bytes.subarray(0, 8)).toString("utf8") === "bplist00") {
    return parseBuffer<unknown>(Buffer.from(bytes))[0];
  }
  // Decode strictly so malformed UTF-16 cannot silently change a version or path.
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  return parseXmlPlist(new TextDecoder(encoding, { fatal: true }).decode(bytes));
}

export function isPlistDictionary(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
