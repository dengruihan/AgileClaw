/**
 * Minimal read-only ZIP reader for OOXML packages.
 *
 * Office previews must never inflate untrusted archives without a hard byte
 * budget. `jszip` (used elsewhere for trusted test fixtures) inflates entries
 * with the size the archive declares, and a hostile archive can declare a tiny
 * entry that expands to gigabytes. This reader therefore trusts only bounded
 * central-directory metadata, rejects oversized or over-compressed archives
 * before touching entry data, and inflates individual entries through Node's
 * `zlib` with `maxOutputLength` as an absolute ceiling.
 */
import { inflateRawSync } from "node:zlib";
import {
  OFFICE_PREVIEW_MAX_ZIP_COMPRESSION_RATIO,
  OFFICE_PREVIEW_MAX_ZIP_ENTRIES,
  OFFICE_PREVIEW_MAX_ZIP_ENTRY_BYTES,
  OFFICE_PREVIEW_MAX_ZIP_UNCOMPRESSED_BYTES,
} from "./office-preview-limits.js";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_FILE = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_ENTRY_COUNT = 0xffff;
const ZIP64_SIZE = 0xffffffff;
const MAX_EOCD_SCAN_BYTES = 66_000;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const UTF8_BOM = "\uFEFF";
// Tiny XML parts compress far past any useful ratio; only suspiciously large
// expansions indicate a zip bomb.
const RATIO_CHECK_MIN_BYTES = 1024 * 1024;

export type OfficeArchiveFailure =
  | "not_zip"
  | "zip64"
  | "encrypted"
  | "entry_limit"
  | "entry_too_large"
  | "archive_too_large"
  | "compression_ratio"
  | "truncated"
  | "unsupported_compression";

/** Raised for archives the preview reader refuses to expand. */
export class OfficeArchiveError extends Error {
  constructor(readonly reason: OfficeArchiveFailure) {
    super(`Office archive rejected: ${reason}`);
    this.name = "OfficeArchiveError";
  }
}

type OfficeZipEntry = {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

function findEndOfCentralDirectory(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - MAX_EOCD_SCAN_BYTES);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }
  return -1;
}

function readEntryDataOffset(
  buffer: Buffer,
  entry: OfficeZipEntry,
  directoryOffset: number,
): number {
  const header = entry.localHeaderOffset;
  if (
    header < 0 ||
    header + 30 > buffer.length ||
    header + 30 > directoryOffset ||
    buffer.readUInt32LE(header) !== LOCAL_FILE_HEADER
  ) {
    throw new OfficeArchiveError("truncated");
  }
  const nameLength = buffer.readUInt16LE(header + 26);
  const extraLength = buffer.readUInt16LE(header + 28);
  const dataOffset = header + 30 + nameLength + extraLength;
  if (dataOffset + entry.compressedSize > buffer.length) {
    throw new OfficeArchiveError("truncated");
  }
  return dataOffset;
}

/** Parses and validates the central directory without expanding any entry. */
function readCentralDirectory(buffer: Buffer): {
  entries: Map<string, OfficeZipEntry>;
  directoryOffset: number;
} {
  if (buffer.length < 22) {
    throw new OfficeArchiveError("not_zip");
  }
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) {
    throw new OfficeArchiveError("not_zip");
  }
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (
    entryCount === ZIP64_ENTRY_COUNT ||
    directorySize === ZIP64_SIZE ||
    directoryOffset === ZIP64_SIZE
  ) {
    // ZIP64 archives exceed what a previewable Office file can be.
    throw new OfficeArchiveError("zip64");
  }
  if (entryCount === 0) {
    throw new OfficeArchiveError("not_zip");
  }
  if (entryCount > OFFICE_PREVIEW_MAX_ZIP_ENTRIES) {
    throw new OfficeArchiveError("entry_limit");
  }
  if (directoryOffset + directorySize > buffer.length) {
    throw new OfficeArchiveError("truncated");
  }

  const entries = new Map<string, OfficeZipEntry>();
  let cursor = directoryOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_FILE) {
      throw new OfficeArchiveError("truncated");
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    if (nameStart + nameLength > buffer.length) {
      throw new OfficeArchiveError("truncated");
    }
    const name = buffer.toString("utf8", nameStart, nameStart + nameLength);
    if (compressedSize === ZIP64_SIZE || uncompressedSize === ZIP64_SIZE) {
      throw new OfficeArchiveError("zip64");
    }
    if ((flags & 0x1) !== 0) {
      throw new OfficeArchiveError("encrypted");
    }
    if (uncompressedSize > OFFICE_PREVIEW_MAX_ZIP_ENTRY_BYTES) {
      throw new OfficeArchiveError("entry_too_large");
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > OFFICE_PREVIEW_MAX_ZIP_UNCOMPRESSED_BYTES) {
      throw new OfficeArchiveError("archive_too_large");
    }
    if (
      uncompressedSize >= RATIO_CHECK_MIN_BYTES &&
      uncompressedSize / Math.max(1, compressedSize) > OFFICE_PREVIEW_MAX_ZIP_COMPRESSION_RATIO
    ) {
      throw new OfficeArchiveError("compression_ratio");
    }
    entries.set(name, {
      name,
      method,
      flags,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  return { entries, directoryOffset };
}

/** Read-only view of one validated OOXML package. */
export class OfficeZipArchive {
  private readonly entries: Map<string, OfficeZipEntry>;
  private readonly directoryOffset: number;
  private readonly buffer: Buffer;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
    const directory = readCentralDirectory(buffer);
    this.entries = directory.entries;
    this.directoryOffset = directory.directoryOffset;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  names(): readonly string[] {
    return [...this.entries.keys()];
  }

  /** Returns UTF-8 text for one entry, or undefined when the entry is absent. */
  readText(name: string): string | undefined {
    const bytes = this.readBytes(name);
    if (!bytes) {
      return undefined;
    }
    const text = bytes.toString("utf8");
    return text.startsWith(UTF8_BOM) ? text.slice(UTF8_BOM.length) : text;
  }

  readBytes(name: string): Buffer | undefined {
    const entry = this.entries.get(name);
    if (!entry) {
      return undefined;
    }
    const dataOffset = readEntryDataOffset(this.buffer, entry, this.directoryOffset);
    const compressed = this.buffer.subarray(dataOffset, dataOffset + entry.compressedSize);
    if (entry.method === METHOD_STORED) {
      if (compressed.length !== entry.uncompressedSize) {
        throw new OfficeArchiveError("truncated");
      }
      return Buffer.from(compressed);
    }
    if (entry.method !== METHOD_DEFLATE) {
      throw new OfficeArchiveError("unsupported_compression");
    }
    let inflated: Buffer;
    try {
      inflated = inflateRawSync(compressed, {
        // The ceiling stays authoritative even when the directory lies.
        maxOutputLength: OFFICE_PREVIEW_MAX_ZIP_ENTRY_BYTES + 1,
      });
    } catch {
      throw new OfficeArchiveError("truncated");
    }
    if (inflated.length !== entry.uncompressedSize) {
      throw new OfficeArchiveError("truncated");
    }
    return inflated;
  }
}
