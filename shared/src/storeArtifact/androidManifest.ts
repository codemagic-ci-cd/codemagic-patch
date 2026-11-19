// `android:versionName` from the two compiled manifest encodings: Android
// binary XML (APK `AndroidManifest.xml`) and aapt2's protobuf XmlNode (AAB
// `base/manifest/AndroidManifest.xml`). Only the root <manifest> element's
// attributes are read. Minimal bounded readers instead of dependencies: the
// formats are stable, the subset is small, and every offset is checked before
// use. Resource tables are never decoded (specs/build-metadata.md §7.1).

import { ArtifactDecodeError } from "./errors";

export const ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android";
/** `android:versionName` in the framework's public attribute ids. */
export const VERSION_NAME_RESOURCE_ID = 0x0101021c;

export type ManifestVersionName =
  | { kind: "literal"; value: string }
  | { kind: "missing" }
  /** A resource reference (`@string/...`), or a theme attribute reference. */
  | { kind: "reference" }
  /** Compiled to something other than a string (an integer, a boolean...). */
  | { kind: "not-a-string" };

// ------------------------------------------------------------ binary XML ---

const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_TYPE = 0x0003;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const UTF8_FLAG = 1 << 8;
const NO_INDEX = 0xffffffff;

const TYPE_REFERENCE = 0x01;
const TYPE_ATTRIBUTE = 0x02;
const TYPE_STRING = 0x03;
const TYPE_DYNAMIC_REFERENCE = 0x07;
const TYPE_DYNAMIC_ATTRIBUTE = 0x08;

const MAX_CHUNKS = 100_000;

export function readBinaryXmlVersionName(bytes: Uint8Array): ManifestVersionName {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (message: string): never => {
    throw new ArtifactDecodeError(`AndroidManifest.xml: ${message}`);
  };

  if (bytes.length < 8 || data.getUint16(0, true) !== RES_XML_TYPE) {
    fail("not an Android binary XML document");
  }
  const documentHeader = data.getUint16(2, true);
  const documentSize = data.getUint32(4, true);
  if (documentHeader < 8 || documentSize > bytes.length || documentHeader > documentSize) {
    fail("document header is out of range");
  }

  let strings: StringPool | null = null;
  let resourceIds: number[] = [];
  let offset = documentHeader;
  let chunks = 0;

  while (offset + 8 <= documentSize) {
    chunks += 1;
    if (chunks > MAX_CHUNKS) fail("too many chunks");
    const type = data.getUint16(offset, true);
    const headerSize = data.getUint16(offset + 2, true);
    const size = data.getUint32(offset + 4, true);
    if (headerSize < 8 || size < headerSize || offset + size > documentSize) {
      fail(`chunk at ${offset} is out of range`);
    }

    if (type === RES_STRING_POOL_TYPE && strings === null) {
      strings = readStringPool(data, offset, headerSize, size, fail);
    } else if (type === RES_XML_RESOURCE_MAP_TYPE) {
      resourceIds = [];
      for (let cursor = offset + headerSize; cursor + 4 <= offset + size; cursor += 4) {
        resourceIds.push(data.getUint32(cursor, true));
      }
    } else if (type === RES_XML_START_ELEMENT_TYPE) {
      if (strings === null) fail("element before the string pool");
      return readManifestElement(data, offset, headerSize, size, strings!, resourceIds, fail);
    }
    offset += size;
  }

  return fail("no <manifest> element");
}

type StringPool = { count: number; get: (index: number) => string };

function readStringPool(
  data: DataView,
  chunk: number,
  headerSize: number,
  size: number,
  fail: (message: string) => never,
): StringPool {
  if (headerSize < 28) fail("string pool header is too short");
  const count = data.getUint32(chunk + 8, true);
  const flags = data.getUint32(chunk + 16, true);
  const stringsStart = data.getUint32(chunk + 20, true);
  const end = chunk + size;
  if (chunk + headerSize + count * 4 > end || chunk + stringsStart > end) {
    fail("string pool is out of range");
  }
  const utf8 = (flags & UTF8_FLAG) !== 0;
  const base = chunk + stringsStart;
  const cache = new Map<number, string>();

  const get = (index: number): string => {
    const cached = cache.get(index);
    if (cached !== undefined) return cached;
    if (index >= count) fail("string index is out of range");
    const start = base + data.getUint32(chunk + headerSize + index * 4, true);
    let value: string;
    if (utf8) {
      // UTF-16 length then UTF-8 byte length, each one or two bytes.
      let cursor = start;
      const readLength8 = (): number => {
        if (cursor + 1 > end) fail("string is out of range");
        const first = data.getUint8(cursor);
        if (first & 0x80) {
          if (cursor + 2 > end) fail("string is out of range");
          const length = ((first & 0x7f) << 8) | data.getUint8(cursor + 1);
          cursor += 2;
          return length;
        }
        cursor += 1;
        return first;
      };
      readLength8();
      const byteLength = readLength8();
      if (cursor + byteLength > end) fail("string is out of range");
      try {
        value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          new Uint8Array(data.buffer, data.byteOffset + cursor, byteLength),
        );
      } catch {
        return fail("string is not valid UTF-8");
      }
    } else {
      let cursor = start;
      if (cursor + 2 > end) fail("string is out of range");
      let length = data.getUint16(cursor, true);
      cursor += 2;
      if (length & 0x8000) {
        if (cursor + 2 > end) fail("string is out of range");
        length = ((length & 0x7fff) << 16) | data.getUint16(cursor, true);
        cursor += 2;
      }
      if (cursor + length * 2 > end) fail("string is out of range");
      let text = "";
      for (let unit = 0; unit < length; unit += 1) {
        text += String.fromCharCode(data.getUint16(cursor + unit * 2, true));
      }
      value = text;
    }
    cache.set(index, value);
    return value;
  };

  return { count, get };
}

function readManifestElement(
  data: DataView,
  chunk: number,
  headerSize: number,
  size: number,
  strings: StringPool,
  resourceIds: readonly number[],
  fail: (message: string) => never,
): ManifestVersionName {
  const end = chunk + size;
  const ext = chunk + headerSize;
  if (headerSize < 16 || ext + 20 > end) fail("start element is out of range");

  const nameIndex = data.getUint32(ext + 4, true);
  if (strings.get(nameIndex) !== "manifest") {
    fail(`root element is <${strings.get(nameIndex)}>, not <manifest>`);
  }
  const attributeStart = data.getUint16(ext + 8, true);
  const attributeSize = data.getUint16(ext + 10, true);
  const attributeCount = data.getUint16(ext + 12, true);
  if (attributeSize < 20 || ext + attributeStart + attributeCount * attributeSize > end) {
    fail("attributes are out of range");
  }

  for (let index = 0; index < attributeCount; index += 1) {
    const attribute = ext + attributeStart + index * attributeSize;
    const namespaceIndex = data.getUint32(attribute, true);
    const attributeName = data.getUint32(attribute + 4, true);
    const resourceId = attributeName < resourceIds.length ? resourceIds[attributeName] : undefined;
    const isVersionName =
      resourceId !== undefined && resourceId !== 0
        ? resourceId === VERSION_NAME_RESOURCE_ID
        : namespaceIndex !== NO_INDEX &&
          strings.get(namespaceIndex) === ANDROID_NAMESPACE &&
          strings.get(attributeName) === "versionName";
    if (!isVersionName) continue;

    // Res_value: size (2), res0 (1), dataType (1), data (4) after rawValue.
    const dataType = data.getUint8(attribute + 15);
    const value = data.getUint32(attribute + 16, true);
    if (
      dataType === TYPE_REFERENCE ||
      dataType === TYPE_ATTRIBUTE ||
      dataType === TYPE_DYNAMIC_REFERENCE ||
      dataType === TYPE_DYNAMIC_ATTRIBUTE
    ) {
      return { kind: "reference" };
    }
    if (dataType === TYPE_STRING) {
      return { kind: "literal", value: strings.get(value) };
    }
    // aapt2 may keep a raw string next to a typed value, but a value compiled
    // to an integer or boolean is not a literal version string.
    return { kind: "not-a-string" };
  }

  return { kind: "missing" };
}

// -------------------------------------------------------------- protobuf ---

// aapt2 Resources.proto field numbers.
const XML_NODE_ELEMENT = 1;
const XML_ELEMENT_NAMESPACE_URI = 2;
const XML_ELEMENT_NAME = 3;
const XML_ELEMENT_ATTRIBUTE = 4;
const XML_ATTRIBUTE_NAMESPACE_URI = 1;
const XML_ATTRIBUTE_NAME = 2;
const XML_ATTRIBUTE_VALUE = 3;
const XML_ATTRIBUTE_RESOURCE_ID = 5;
const XML_ATTRIBUTE_COMPILED_ITEM = 6;
const ITEM_REF = 1;
const ITEM_STR = 2;
const ITEM_RAW_STR = 3;
const STRING_VALUE = 1;

type ProtoField = { bytes?: Uint8Array; number: number; varint?: number };

export function readProtoXmlVersionName(bytes: Uint8Array): ManifestVersionName {
  const node = decodeMessage(bytes, "XmlNode");
  const elementBytes = lastBytes(node, XML_NODE_ELEMENT);
  if (elementBytes === undefined) {
    throw new ArtifactDecodeError("base/manifest/AndroidManifest.xml: root node is not an element");
  }
  const element = decodeMessage(elementBytes, "XmlElement");
  const name = text(lastBytes(element, XML_ELEMENT_NAME));
  const namespace = text(lastBytes(element, XML_ELEMENT_NAMESPACE_URI));
  if (name !== "manifest" || namespace !== "") {
    throw new ArtifactDecodeError(
      `base/manifest/AndroidManifest.xml: root element is <${name}>, not <manifest>`,
    );
  }

  for (const field of element) {
    if (field.number !== XML_ELEMENT_ATTRIBUTE || field.bytes === undefined) continue;
    const attribute = decodeMessage(field.bytes, "XmlAttribute");
    const resourceId = lastVarint(attribute, XML_ATTRIBUTE_RESOURCE_ID) ?? 0;
    const isVersionName =
      resourceId !== 0
        ? resourceId === VERSION_NAME_RESOURCE_ID
        : text(lastBytes(attribute, XML_ATTRIBUTE_NAMESPACE_URI)) === ANDROID_NAMESPACE &&
          text(lastBytes(attribute, XML_ATTRIBUTE_NAME)) === "versionName";
    if (!isVersionName) continue;

    const compiled = lastBytes(attribute, XML_ATTRIBUTE_COMPILED_ITEM);
    if (compiled !== undefined) {
      const item = decodeMessage(compiled, "Item");
      if (lastBytes(item, ITEM_REF) !== undefined) {
        return { kind: "reference" };
      }
      const stringItem = lastBytes(item, ITEM_STR) ?? lastBytes(item, ITEM_RAW_STR);
      if (stringItem !== undefined) {
        return { kind: "literal", value: text(lastBytes(decodeMessage(stringItem, "String"), STRING_VALUE)) };
      }
      if (item.length > 0) {
        return { kind: "not-a-string" };
      }
    }
    return { kind: "literal", value: text(lastBytes(attribute, XML_ATTRIBUTE_VALUE)) };
  }

  return { kind: "missing" };
}

function decodeMessage(bytes: Uint8Array, label: string): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  const fail = (message: string): never => {
    throw new ArtifactDecodeError(`base/manifest/AndroidManifest.xml: ${label} ${message}`);
  };

  const readVarint = (): number => {
    let value = 0;
    let scale = 1;
    for (let index = 0; index < 10; index += 1) {
      if (offset >= bytes.length) fail("is truncated");
      const byte = bytes[offset];
      offset += 1;
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) {
        return value;
      }
      scale *= 128;
    }
    return fail("has an overlong varint");
  };

  while (offset < bytes.length) {
    const key = readVarint();
    const number = Math.floor(key / 8);
    const wireType = key % 8;
    if (number === 0) fail("has field number 0");
    switch (wireType) {
      case 0:
        fields.push({ number, varint: readVarint() });
        break;
      case 1:
        if (offset + 8 > bytes.length) fail("is truncated");
        offset += 8;
        break;
      case 2: {
        const length = readVarint();
        if (length > bytes.length - offset) fail("has a field longer than its message");
        fields.push({ bytes: bytes.subarray(offset, offset + length), number });
        offset += length;
        break;
      }
      case 5:
        if (offset + 4 > bytes.length) fail("is truncated");
        offset += 4;
        break;
      default:
        fail(`uses unsupported wire type ${wireType}`);
    }
  }
  return fields;
}

function lastBytes(fields: readonly ProtoField[], number: number): Uint8Array | undefined {
  let found: Uint8Array | undefined;
  for (const field of fields) {
    if (field.number === number && field.bytes !== undefined) found = field.bytes;
  }
  return found;
}

function lastVarint(fields: readonly ProtoField[], number: number): number | undefined {
  let found: number | undefined;
  for (const field of fields) {
    if (field.number === number && field.varint !== undefined) found = field.varint;
  }
  return found;
}

function text(bytes: Uint8Array | undefined): string {
  if (bytes === undefined) {
    return "";
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ArtifactDecodeError("base/manifest/AndroidManifest.xml: a string is not valid UTF-8");
  }
}
