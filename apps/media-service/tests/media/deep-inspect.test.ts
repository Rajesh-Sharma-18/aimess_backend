/**
 * Structural inspector unit tests — the format-by-format security matrix.
 *
 * These exercise `inspectMedia` directly (no HTTP, no storage) so each format's
 * accept/reject boundary is asserted on its own terms: real files pass, and each
 * documented attack class is rejected with the specific code the audit names.
 */

import { inspectMedia, sniff, stripImageMetadata } from "@aimess/storage";
import { MEDIA_STRUCTURAL_LIMITS as LIMITS } from "@aimess/constants";

import {
  buildZip,
  isobmffFtyp,
  validGif,
  validHeic,
  validJpeg,
  validMp4,
  validPng,
  validWebp,
} from "../helpers/fixtures.js";

const inspect = (
  buf: Buffer,
  declaredMime: string,
  overrides: Partial<Parameters<typeof inspectMedia>[0]> = {}
) =>
  inspectMedia({
    head: buf,
    totalSize: buf.length,
    declaredMime,
    complete: true,
    ...overrides,
  });

describe("inspectMedia — valid files of every supported format", () => {
  it.each([
    ["PNG", () => validPng({ width: 32, height: 24 }), "image/png", 32, 24],
    ["JPEG", () => validJpeg({ width: 64, height: 48 }), "image/jpeg", 64, 48],
    ["GIF", () => validGif({ width: 12, height: 10 }), "image/gif", 12, 10],
    ["WebP", () => validWebp(20, 30), "image/webp", 20, 30],
    ["HEIC", () => validHeic(4032, 3024), "image/heic", 4032, 3024],
  ])("accepts a valid %s and reads its dimensions", (_n, make, mime, w, h) => {
    const result = inspect(make(), mime);
    expect(result.ok).toBe(true);
    expect(result.width).toBe(w);
    expect(result.height).toBe(h);
  });

  it("accepts a valid MP4 and reads its duration and track size", () => {
    const result = inspect(
      validMp4({ durationMs: 12_000, width: 1920, height: 1080 }),
      "video/mp4"
    );
    expect(result.ok).toBe(true);
    expect(Math.round(result.durationMs ?? 0)).toBe(12_000);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
  });

  it("accepts HEIF declared as image/heif (same container family)", () => {
    expect(inspect(validHeic(), "image/heif").ok).toBe(true);
  });

  it("counts GIF frames", () => {
    const result = inspect(validGif({ frames: 5 }), "image/gif");
    expect(result.ok).toBe(true);
    expect(result.frames).toBe(5);
  });
});

describe("inspectMedia — signature and structure mismatches", () => {
  it("rejects a JPEG declared as PNG", () => {
    const result = inspect(validJpeg(), "image/png");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SIGNATURE_MISMATCH");
  });

  it("rejects a PNG whose header is right but has no IEND (truncated)", () => {
    const result = inspect(validPng({ omitIend: true }), "image/png");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("TRUNCATED");
  });

  it("rejects a JPEG with no EOI", () => {
    const result = inspect(validJpeg({ omitEoi: true }), "image/jpeg");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("TRUNCATED");
  });

  it("rejects a GIF with no trailer", () => {
    const result = inspect(validGif({ omitTrailer: true }), "image/gif");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("TRUNCATED");
  });

  it("rejects a bare signature with no real structure behind it", () => {
    // This is exactly what the OLD magic-byte-only check accepted as "a PNG".
    const headerOnly = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
    ]);
    const result = inspect(headerOnly, "image/png");
    expect(result.ok).toBe(false);
  });

  it("rejects an empty object", () => {
    const result = inspectMedia({
      head: Buffer.alloc(0),
      totalSize: 0,
      declaredMime: "image/png",
      complete: true,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("EMPTY");
  });

  it("distinguishes HEIC from MP4 by ftyp brand, not by the shared box name", () => {
    // Both start `????ftyp`; the old signature rule called both video/mp4.
    expect(sniff(validHeic())).toBe("image/heic");
    expect(sniff(validMp4())).toBe("video/mp4");
    // A HEIC uploaded as video/mp4 no longer slips through.
    expect(inspect(validHeic(), "video/mp4").ok).toBe(false);
  });

  it("rejects a QuickTime-branded file declared as image/heic", () => {
    const mov = Buffer.concat([isobmffFtyp("qt  ", []), Buffer.alloc(8)]);
    expect(inspect(mov, "image/heic").ok).toBe(false);
  });
});

describe("inspectMedia — classic QuickTime (.mov with no ftyp box)", () => {
  /** A `.mov` as QuickTime Player and several recorders emit it: no ftyp. */
  const classicMov = (): Buffer => {
    const withFtyp = validMp4({
      durationMs: 12_000,
      width: 1920,
      height: 1080,
      brand: "qt  ",
    });
    const ftypLen = withFtyp.readUInt32BE(0);
    const wide = Buffer.alloc(8);
    wide.writeUInt32BE(8, 0);
    wide.write("wide", 4, "latin1");
    return Buffer.concat([wide, withFtyp.subarray(ftypLen)]);
  };

  it("accepts it and still reads duration and track size", () => {
    const result = inspect(classicMov(), "video/quicktime");
    expect(result.ok).toBe(true);
    expect(result.detectedMime).toBe("video/quicktime");
    expect(Math.round(result.durationMs ?? 0)).toBe(12_000);
    expect(result.width).toBe(1920);
  });

  it("sniffs as video/quicktime", () => {
    expect(sniff(classicMov())).toBe("video/quicktime");
  });

  it("does not let an arbitrary blob in as a .mov", () => {
    const junk = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x01, 0x00]),
      Buffer.from("junk", "latin1"),
      Buffer.alloc(16),
    ]);
    expect(inspect(junk, "video/quicktime").ok).toBe(false);
  });

  it("keeps the classic layout out of the other ISOBMFF types", () => {
    expect(inspect(classicMov(), "video/mp4").ok).toBe(false);
  });
});

describe("inspectMedia — polyglot files", () => {
  const ZIP = buildZip([{ name: "payload.txt", content: Buffer.from("x") }]);
  const HTML = Buffer.from("<html><script>alert(1)</script></html>");
  const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);

  it.each([
    ["JPEG + ZIP", () => validJpeg({ trailing: ZIP }), "image/jpeg"],
    ["JPEG + HTML", () => validJpeg({ trailing: HTML }), "image/jpeg"],
    ["JPEG + executable", () => validJpeg({ trailing: EXE }), "image/jpeg"],
    ["PNG + ZIP", () => validPng({ trailing: ZIP }), "image/png"],
    ["GIF + script", () => validGif({ trailing: HTML }), "image/gif"],
  ])("rejects a %s polyglot", (_name, make, mime) => {
    const result = inspect(make(), mime);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("TRAILING_DATA");
  });

  it("tolerates a few bytes of encoder padding after the end marker", () => {
    const result = inspect(
      validPng({ trailing: Buffer.alloc(4) }),
      "image/png"
    );
    expect(result.ok).toBe(true);
  });

  // Every HDR phone photo is an MPF/Ultra HDR file: the primary image followed
  // by a complete second JPEG holding the gain map. Rejecting that as trailing
  // data rejected ordinary camera output.
  it("accepts a multi-image (MPF / Ultra HDR) JPEG and reports the primary size", () => {
    const gainMap = validJpeg({ width: 32, height: 24 });
    const result = inspect(
      validJpeg({ width: 3072, height: 4080, trailing: gainMap }),
      "image/jpeg"
    );
    expect(result.ok).toBe(true);
    expect(result.width).toBe(3072);
    expect(result.height).toBe(4080);
  });

  // Samsung trailer layout: blocks [u16 0][u16 type][u32 nameLen][name][data], then SEFH dir, then u32le dirLen + "SEFT".
  const seft = (blocks: Array<{ type: number; name: string; data: Buffer }>) => {
    const bodies = blocks.map(({ type, name, data }) => {
      const head = Buffer.alloc(8);
      head.writeUInt16LE(type, 2);
      head.writeUInt32LE(name.length, 4);
      return Buffer.concat([head, Buffer.from(name, "latin1"), data]);
    });
    const total = bodies.reduce((n, b) => n + b.length, 0);
    const dir = Buffer.alloc(12 + blocks.length * 12);
    dir.write("SEFH", 0, "latin1");
    dir.writeUInt32LE(107, 4);
    dir.writeUInt32LE(blocks.length, 8);
    let offset = total;
    bodies.forEach((body, i) => {
      dir.writeUInt16LE(blocks[i]!.type, 12 + i * 12 + 2);
      dir.writeUInt32LE(offset, 12 + i * 12 + 4);
      dir.writeUInt32LE(body.length, 12 + i * 12 + 8);
      offset -= body.length;
    });
    const end = Buffer.alloc(8);
    end.writeUInt32LE(dir.length, 0);
    end.write("SEFT", 4, "latin1");
    return Buffer.concat([...bodies, dir, end]);
  };
  const SAMSUNG = seft([
    { type: 0x0a01, name: "Image_UTC_Data", data: Buffer.from("1792060273440") },
    { type: 0x0ba1, name: "Original_Path_Hash_Key", data: Buffer.from("abc123") },
  ]);

  it("accepts a Samsung Gallery/screenshot JPEG with its SEFT trailer", () => {
    const result = inspect(validJpeg({ width: 64, height: 48, trailing: SAMSUNG }), "image/jpeg");
    expect(result.ok).toBe(true);
    expect(result.width).toBe(64);
  });

  it("accepts a Samsung HDR JPEG: gain map then SEFT trailer", () => {
    const gainMap = validJpeg({ width: 32, height: 24 });
    const result = inspect(
      validJpeg({ trailing: Buffer.concat([gainMap, SAMSUNG]) }),
      "image/jpeg"
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    ["a payload before the trailer", () => Buffer.concat([ZIP, SAMSUNG])],
    ["a payload after SEFT", () => Buffer.concat([SAMSUNG, ZIP])],
    ["a bare SEFT tag", () => Buffer.concat([ZIP, Buffer.from("\x00\x00\x00\x00SEFT", "latin1")])],
    [
      "a block whose header names another type",
      () => {
        const forged = Buffer.from(SAMSUNG);
        forged.writeUInt16LE(0xffff, 2);
        return forged;
      },
    ],
  ])("still rejects %s", (_name, trailing) => {
    const result = inspect(validJpeg({ trailing: trailing() }), "image/jpeg");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("TRAILING_DATA");
  });

  it("still rejects a payload appended after the gain map", () => {
    const gainMap = validJpeg({ width: 32, height: 24 });
    const result = inspect(
      validJpeg({ trailing: Buffer.concat([gainMap, ZIP]) }),
      "image/jpeg"
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("TRAILING_DATA");
  });
});

describe("inspectMedia — decompression bombs and resource limits", () => {
  it("rejects a tiny PNG that declares an enormous canvas", () => {
    // ~100 bytes on disk, 64000 x 64000 = 4.1 Gpx ≈ 16 GB of RGBA in a decoder.
    const bomb = validPng({ width: 64_000, height: 64_000 });
    expect(bomb.length).toBeLessThan(200);
    const result = inspect(bomb, "image/png");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("DIMENSIONS_EXCEEDED");
  });

  it("rejects an image over the total-pixel budget even when each side is legal", () => {
    const result = inspect(
      validPng({ width: 19_000, height: 19_000 }),
      "image/png"
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("PIXELS_EXCEEDED");
  });

  it("rejects a GIF with more frames than the limit", () => {
    const result = inspectMedia({
      head: validGif({ frames: 40 }),
      totalSize: validGif({ frames: 40 }).length,
      declaredMime: "image/gif",
      complete: true,
      limits: { ...LIMITS, maxAnimationFrames: 10 },
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("FRAMES_EXCEEDED");
  });

  it("rejects an APNG whose animation-control chunk declares too many frames", () => {
    const png = validPng({ frames: 100_000 });
    const result = inspect(png, "image/png");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("FRAMES_EXCEEDED");
  });

  it("rejects a video longer than the duration limit", () => {
    const long = validMp4({ durationMs: 5 * 60 * 60 * 1000 });
    const result = inspect(long, "video/mp4");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("DURATION_EXCEEDED");
  });

  it("rejects a video track larger than the dimension limit", () => {
    const huge = validMp4({ width: 16_000, height: 9_000 });
    const result = inspect(huge, "video/mp4");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("DIMENSIONS_EXCEEDED");
  });
});

describe("inspectMedia — textual formats (previously unchecked entirely)", () => {
  it("rejects an executable declared as text/plain", () => {
    // The exact bypass: text/* had an EMPTY magic-byte accept-set, so declaring
    // text/plain skipped every content check.
    const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x04]);
    const result = inspect(exe, "text/plain");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SIGNATURE_MISMATCH");
  });

  it("rejects a ZIP declared as application/json", () => {
    const result = inspect(buildZip([{ name: "a.txt" }]), "application/json");
    expect(result.ok).toBe(false);
  });

  it("rejects binary content (NUL bytes) declared as text/plain", () => {
    const result = inspect(Buffer.from("hello\0world", "latin1"), "text/plain");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SIGNATURE_MISMATCH");
  });

  it("rejects HTML/script smuggled into a text/plain upload", () => {
    const result = inspect(
      Buffer.from("<script>alert(1)</script>"),
      "text/plain"
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SUSPICIOUS_CONTENT");
  });

  it("rejects an XML entity declaration (XXE / billion laughs)", () => {
    const xxe = Buffer.from(
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">]><lolz/>'
    );
    const result = inspect(xxe, "application/xml");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SUSPICIOUS_CONTENT");
  });

  it("rejects malformed JSON declared as application/json", () => {
    const result = inspect(Buffer.from("{not json"), "application/json");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("MALFORMED_CONTAINER");
  });

  it("accepts ordinary text and JSON", () => {
    expect(inspect(Buffer.from("hello, world\n"), "text/plain").ok).toBe(true);
    expect(inspect(Buffer.from('{"a":1}'), "application/json").ok).toBe(true);
    expect(inspect(Buffer.from("a,b\n1,2\n"), "text/csv").ok).toBe(true);
  });
});

describe("inspectMedia — PDF active content", () => {
  const pdf = (body: string): Buffer => Buffer.from(`%PDF-1.7\n${body}\n%%EOF`);

  it("accepts an ordinary PDF", () => {
    expect(
      inspect(pdf("1 0 obj<</Type/Catalog>>endobj"), "application/pdf").ok
    ).toBe(true);
  });

  it.each([
    ["/JavaScript", "/JavaScript (app.alert\\(1\\))"],
    ["/OpenAction", "<</OpenAction 2 0 R>>"],
    ["/Launch", "<</S/Launch/F(cmd.exe)>>"],
    ["/EmbeddedFile", "<</Type/EmbeddedFile>>"],
    ["/AA", "<</Type/Page/AA<</O 3 0 R>>>>"],
    ["/JS", "<</S/JavaScript/JS(x)>>"],
  ])("rejects a PDF containing %s", (_label, body) => {
    const result = inspect(pdf(body), "application/pdf");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SUSPICIOUS_CONTENT");
  });

  // Chrome "Save as PDF" subsets fonts as /AAAAAA+Name — a name that only starts with /AA.
  it("accepts a PDF whose font subset name starts with /AA or /JS", () => {
    const body =
      "<</Type/Font/BaseFont/AAAAAA+SegoeUI-Bold>> <</BaseFont/JSAAAA+Mono>>";
    expect(inspect(pdf(body), "application/pdf").ok).toBe(true);
  });

  it("rejects a PDF with no %%EOF", () => {
    const result = inspect(Buffer.from("%PDF-1.7\nbroken"), "application/pdf");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("TRUNCATED");
  });
});

describe("metadata detection and stripping", () => {
  it("reports EXIF and GPS on a JPEG that carries them", () => {
    const result = inspect(validJpeg({ gps: true }), "image/jpeg");
    expect(result.ok).toBe(true);
    expect(result.metadata).toEqual(expect.arrayContaining(["exif", "gps"]));
  });

  it("reports EXIF on a PNG eXIf chunk", () => {
    const result = inspect(validPng({ exif: true }), "image/png");
    expect(result.metadata).toContain("exif");
  });

  it("strips JPEG EXIF/GPS while keeping the image valid", () => {
    const withGps = validJpeg({ gps: true, width: 40, height: 30 });
    const stripped = stripImageMetadata(withGps, "image/jpeg");

    expect(stripped.length).toBeLessThan(withGps.length);
    const after = inspect(stripped, "image/jpeg");
    expect(after.ok).toBe(true);
    expect(after.width).toBe(40);
    expect(after.height).toBe(30);
    expect(after.metadata).not.toContain("exif");
    expect(after.metadata).not.toContain("gps");
  });

  it("strips PNG metadata chunks while keeping the image valid", () => {
    const withExif = validPng({ exif: true, width: 24, height: 18 });
    const stripped = stripImageMetadata(withExif, "image/png");

    const after = inspect(stripped, "image/png");
    expect(after.ok).toBe(true);
    expect(after.width).toBe(24);
    expect(after.metadata).not.toContain("exif");
  });

  it("returns the input unchanged for formats it cannot safely edit", () => {
    const gif = validGif();
    expect(stripImageMetadata(gif, "image/gif")).toBe(gif);
  });
});
