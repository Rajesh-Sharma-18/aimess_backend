/**
 * ZIP inspector unit tests.
 *
 * Each `describe` below corresponds to a bypass the audit found in the old
 * local-file-header walk. They are the reason the inspector now reads the
 * central directory instead.
 */

import {
  detectOoxmlActiveContent,
  detectOoxmlType,
  inspectZip,
  ZipInspectionError,
} from "../../src/lib/zip-inspector.js";
import { buildDocx, buildZip } from "../helpers/fixtures.js";

const expectRejection = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ZipInspectionError);
    expect((err as ZipInspectionError).code).toBe(code);
    return;
  }
  throw new Error(
    `expected ZipInspectionError(${code}) but nothing was thrown`
  );
};

describe("inspectZip — valid archives", () => {
  it("accepts an ordinary ZIP and returns its entries", () => {
    const zip = buildZip([
      { name: "a.txt", content: Buffer.from("hello") },
      { name: "docs/b.txt", content: Buffer.from("world") },
    ]);
    const entries = inspectZip(zip, zip.length);
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "docs/b.txt"]);
  });

  it("accepts an empty archive", () => {
    const zip = buildZip([]);
    expect(inspectZip(zip, zip.length)).toEqual([]);
  });
});

describe("inspectZip — ZIP bombs", () => {
  it("rejects an archive whose declared expansion exceeds the ratio limit", () => {
    // 10 bytes stored, 10 MB declared → ratio far above the 100:1 default.
    const zip = buildZip([
      {
        name: "bomb.bin",
        content: Buffer.alloc(10),
        uncompressedSize: 10_000_000,
      },
    ]);
    expectRejection(() => inspectZip(zip, zip.length), "ZIP_BOMB_DETECTED");
  });

  it("rejects an archive over the absolute uncompressed-size ceiling", () => {
    // Under the ratio (the file is padded) but still 3 GiB of expansion.
    const padded = Buffer.alloc(64 * 1024 * 1024);
    const zip = buildZip([
      {
        name: "big.bin",
        content: Buffer.alloc(16),
        uncompressedSize: 3 * 1024 ** 3,
      },
    ]);
    expectRejection(() => inspectZip(zip, padded.length), "ZIP_BOMB_DETECTED");
  });

  it("catches a bomb that sets the data-descriptor flag", () => {
    // BYPASS #1: with general-purpose flag bit 3 set, the LOCAL header carries
    // zeroed sizes, so the old walk summed 0 and skipped its own ratio check.
    // The central directory always carries the true sizes.
    const zip = buildZip([
      {
        name: "bomb.bin",
        content: Buffer.alloc(10),
        uncompressedSize: 50_000_000,
        dataDescriptor: true,
      },
    ]);
    expectRejection(() => inspectZip(zip, zip.length), "ZIP_BOMB_DETECTED");
  });

  it("catches a bomb hidden behind a forged trailing EOCD", () => {
    // BYPASS #2: appending a second 22-byte EOCD claiming `totalEntries = 1`
    // made the old backwards scan read the forged count. Candidates are now
    // validated against the central directory they point at.
    const real = buildZip([
      {
        name: "bomb.bin",
        content: Buffer.alloc(10),
        uncompressedSize: 9_000_000,
      },
    ]);
    const forged = Buffer.alloc(22);
    forged.writeUInt32LE(0x06054b50, 0);
    forged.writeUInt16LE(1, 8);
    forged.writeUInt16LE(1, 10);
    forged.writeUInt32LE(0, 12);
    forged.writeUInt32LE(0, 16);
    const tampered = Buffer.concat([real, forged]);

    expectRejection(
      () => inspectZip(tampered, tampered.length),
      "ZIP_BOMB_DETECTED"
    );
  });
});

describe("inspectZip — nested archives and executables", () => {
  it("rejects a nested archive even when it is DEFLATE-compressed", () => {
    // BYPASS #3: the old check peeked at the first bytes of the COMPRESSED
    // payload for a `PK` magic number, so any nested archive stored with the
    // default DEFLATE method was invisible. Matching on the entry NAME is
    // method-independent.
    const zip = buildZip([
      {
        name: "inner.zip",
        content: Buffer.from([0x78, 0x9c, 0x01]),
        method: 8,
      },
    ]);
    expectRejection(() => inspectZip(zip, zip.length), "ZIP_NESTED_ARCHIVE");
  });

  it.each(["inner.rar", "inner.7z", "inner.tar.gz", "inner.iso"])(
    "rejects a nested %s",
    (name) => {
      const zip = buildZip([{ name, content: Buffer.from("x") }]);
      expectRejection(() => inspectZip(zip, zip.length), "ZIP_NESTED_ARCHIVE");
    }
  );

  it.each(["setup.exe", "run.bat", "payload.dll", "script.vbs", "a.ps1"])(
    "rejects an embedded executable %s",
    (name) => {
      const zip = buildZip([{ name, content: Buffer.from("x") }]);
      expectRejection(() => inspectZip(zip, zip.length), "ZIP_NESTED_ARCHIVE");
    }
  );
});

describe("inspectZip — encrypted entries", () => {
  it("rejects an encrypted entry (unreadable by this inspector AND by ClamAV)", () => {
    const zip = buildZip([
      { name: "secret.txt", content: Buffer.from("x"), encrypted: true },
    ]);
    expectRejection(() => inspectZip(zip, zip.length), "ZIP_ENCRYPTED_ENTRY");
  });
});

describe("inspectZip — Zip-Slip entry names", () => {
  it.each([
    "../../etc/passwd",
    "..\\..\\windows\\system32\\evil.dll",
    "/etc/shadow",
    "C:\\Windows\\evil.txt",
  ])("rejects the traversal name %s", (name) => {
    const zip = buildZip([{ name, content: Buffer.from("x") }]);
    expectRejection(() => inspectZip(zip, zip.length), "ZIP_PATH_TRAVERSAL");
  });

  it("rejects an entry name containing a NUL byte", () => {
    const zip = buildZip([
      { name: "safe.txt\0.exe", content: Buffer.from("x") },
    ]);
    expectRejection(() => inspectZip(zip, zip.length), "ZIP_PATH_TRAVERSAL");
  });

  it("accepts an ordinary nested path", () => {
    const zip = buildZip([{ name: "a/b/c.txt", content: Buffer.from("x") }]);
    expect(() => inspectZip(zip, zip.length)).not.toThrow();
  });
});

describe("inspectZip — malformed structure", () => {
  it("rejects a buffer with no EOCD", () => {
    const junk = Buffer.alloc(64, 0x41);
    expectRejection(
      () => inspectZip(junk, junk.length),
      "ZIP_INVALID_STRUCTURE"
    );
  });

  it("rejects a buffer too small to be a ZIP", () => {
    expectRejection(
      () => inspectZip(Buffer.alloc(4), 4),
      "ZIP_INVALID_STRUCTURE"
    );
  });
});

describe("detectOoxmlType — fail closed", () => {
  it("identifies a DOCX from its part names", () => {
    const docx = buildDocx();
    expect(detectOoxmlType(inspectZip(docx, docx.length))).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
  });

  it("returns null for a plain ZIP with no [Content_Types].xml", () => {
    // The caller MUST treat null as a rejection. The old implementation
    // substring-searched DEFLATE-compressed bytes, so it returned null for most
    // real documents and the caller then accepted them.
    const zip = buildZip([{ name: "a.txt", content: Buffer.from("x") }]);
    expect(detectOoxmlType(inspectZip(zip, zip.length))).toBeNull();
  });

  it("returns null for an OOXML container with no recognised part", () => {
    const odd = buildZip([
      { name: "[Content_Types].xml", content: Buffer.from("<Types/>") },
      { name: "unknown/part.xml", content: Buffer.from("<x/>") },
    ]);
    expect(detectOoxmlType(inspectZip(odd, odd.length))).toBeNull();
  });
});

describe("detectOoxmlActiveContent", () => {
  it("flags a VBA project smuggled into a .docx", () => {
    const macro = buildDocx([
      { name: "word/vbaProject.bin", content: Buffer.from("MZ") },
    ]);
    const entries = inspectZip(macro, macro.length);
    expect(detectOoxmlActiveContent(entries)).toContain("VBA macro project");
  });

  it("flags an ActiveX control", () => {
    const ax = buildDocx([
      { name: "word/activeX/activeX1.xml", content: Buffer.from("<x/>") },
    ]);
    expect(detectOoxmlActiveContent(inspectZip(ax, ax.length))).toContain(
      "ActiveX control"
    );
  });

  it("returns null for an ordinary document", () => {
    const docx = buildDocx();
    expect(detectOoxmlActiveContent(inspectZip(docx, docx.length))).toBeNull();
  });
});
