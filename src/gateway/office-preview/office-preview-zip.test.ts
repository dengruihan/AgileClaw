import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { OfficeArchiveError, OfficeZipArchive } from "./office-preview-zip.js";

type RawEntry = {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  /** Lying central-directory size, used to prove the reader re-checks output. */
  declaredUncompressedSize?: number;
  encrypted?: boolean;
};

/** Builds a ZIP by hand so tests can craft hostile central directories. */
function buildRawZip(entries: readonly RawEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const payload = entry.method === 0 ? entry.data : deflateRawSync(entry.data);
    const uncompressedSize = entry.declaredUncompressedSize ?? entry.data.length;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(entry.encrypted ? 1 : 0, 6);
    localHeader.writeUInt16LE(entry.method ?? 8, 8);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.encrypted ? 1 : 0, 8);
    central.writeUInt16LE(entry.method ?? 8, 10);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    localParts.push(localHeader, name, payload);
    centralParts.push(central, name);
    localOffset += localHeader.length + name.length + payload.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function failure(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof OfficeArchiveError ? error.reason : `unexpected: ${String(error)}`;
  }
}

describe("OfficeZipArchive", () => {
  it("reads stored and deflated entries", () => {
    const archive = new OfficeZipArchive(
      buildRawZip([
        { name: "stored.xml", data: Buffer.from("<a/>"), method: 0 },
        { name: "deflated.xml", data: Buffer.from("<b>hello</b>") },
      ]),
    );
    expect(archive.readText("stored.xml")).toBe("<a/>");
    expect(archive.readText("deflated.xml")).toBe("<b>hello</b>");
    expect(archive.readText("missing.xml")).toBeUndefined();
  });

  it("rejects non-zip input and ZIP64 archives", () => {
    expect(failure(() => new OfficeZipArchive(Buffer.from("plain text")))).toBe("not_zip");
    const zip64 = buildRawZip([{ name: "a.xml", data: Buffer.from("x") }]);
    zip64.writeUInt16LE(0xffff, zip64.length - 22 + 10);
    expect(failure(() => new OfficeZipArchive(zip64))).toBe("zip64");
  });

  it("rejects encrypted entries", () => {
    const zip = buildRawZip([{ name: "a.xml", data: Buffer.from("x"), encrypted: true }]);
    expect(failure(() => new OfficeZipArchive(zip))).toBe("encrypted");
  });

  it("rejects entries whose declared size exceeds the preview budget", () => {
    const zip = buildRawZip([
      { name: "bomb.xml", data: Buffer.from("small"), declaredUncompressedSize: 9 * 1024 * 1024 },
    ]);
    expect(failure(() => new OfficeZipArchive(zip))).toBe("entry_too_large");
  });

  it("rejects archives whose large entries expand past the ratio budget", () => {
    const zip = buildRawZip([{ name: "zeros.xml", data: Buffer.alloc(2 * 1024 * 1024) }]);
    expect(failure(() => new OfficeZipArchive(zip))).toBe("compression_ratio");
  });

  it("rejects entries that inflate past their declared size", () => {
    const zip = buildRawZip([
      { name: "liar.xml", data: Buffer.from("x".repeat(64)), declaredUncompressedSize: 8 },
    ]);
    const archive = new OfficeZipArchive(zip);
    expect(failure(() => archive.readText("liar.xml"))).toBe("truncated");
  });

  it("rejects archives with too many entries", () => {
    const entries = Array.from({ length: 2_001 }, (_, index) => ({
      name: `part-${index}.xml`,
      data: Buffer.alloc(0),
      method: 0 as const,
    }));
    expect(failure(() => new OfficeZipArchive(buildRawZip(entries)))).toBe("entry_limit");
  });
});
