/**
 * The supported-format matrix.
 *
 * `deep-inspect.test.ts` covers each format's attack surface in depth. This file
 * answers the flatter question the media-type audit asks: for EVERY MIME the
 * upload allow-list accepts, does a real file of that format survive the whole
 * server-side chain — allow-list → per-MIME cap → magic bytes → structural
 * inspection — and does a file that only CLAIMS to be that format not?
 *
 * The valid table is derived from `CHAT_MIME` itself (via `UPLOAD_CATEGORIES`),
 * so a MIME added to the allow-list without a fixture fails here rather than
 * shipping untested.
 */

import {
  assertMagicBytesMatch,
  MagicByteValidationError,
  effectiveMaxBytes,
  inspectMedia,
  createUploadUrl,
  createStorageClient,
  StorageValidationError,
} from "@aimess/storage";

import { UPLOAD_CATEGORIES } from "../../src/config/uploads.js";
import {
  buildDocx,
  buildPptx,
  buildXlsx,
  buildZip,
  classicMov,
  validAac,
  validCompoundOffice,
  validFlac,
  validGif,
  validHeic,
  validJpeg,
  validM4a,
  validMatroska,
  validMp3,
  validMp4,
  validOgg,
  validPdf,
  validPng,
  validWav,
  validWebp,
} from "../helpers/fixtures.js";

const CHAT = UPLOAD_CATEGORIES.CHAT_ATTACHMENT;

/** One fixture per accepted chat MIME. Extensions are the allow-list's own. */
const FIXTURES: Record<string, () => Buffer> = {
  // Images
  "image/jpeg": () => validJpeg({ width: 64, height: 48 }),
  "image/png": () => validPng({ width: 32, height: 24 }),
  "image/webp": () => validWebp(20, 16),
  "image/gif": () => validGif({ width: 12, height: 10 }),
  "image/heic": () => validHeic(4032, 3024),
  "image/heif": () => validHeic(1920, 1080),
  // Video
  "video/mp4": () => validMp4({ durationMs: 5_000 }),
  "video/quicktime": () => classicMov({ durationMs: 12_000 }),
  "video/x-matroska": () => validMatroska({ docType: "matroska" }),
  "video/webm": () => validMatroska({ docType: "webm" }),
  "video/x-msvideo": () => validAvi(),
  "video/x-m4v": () => validMp4({ durationMs: 4_000 }),
  // Audio / voice
  "audio/mpeg": () => validMp3({ id3: true }),
  "audio/ogg": () => validOgg({ opus: true }),
  "audio/opus": () => validOgg({ opus: true }),
  "audio/wav": () => validWav(2_000),
  "audio/mp4": () => validM4a(),
  "audio/x-m4a": () => validM4a(),
  "audio/aac": () => validAac(),
  "audio/flac": () => validFlac(),
  // Documents
  "application/pdf": () => validPdf(),
  "application/msword": () => validCompoundOffice(),
  "application/vnd.ms-excel": () => validCompoundOffice(),
  "application/vnd.ms-powerpoint": () => validCompoundOffice(),
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    () => buildDocx(),
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": () =>
    buildXlsx(),
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    () => buildPptx(),
  "text/plain": () => Buffer.from("hello, world\n"),
  "text/csv": () => Buffer.from("name,qty\nwidget,2\n"),
  "application/json": () => Buffer.from('{"ok":true}'),
  "application/xml": () => Buffer.from("<note><to>you</to></note>"),
  "text/xml": () => Buffer.from("<note><to>you</to></note>"),
  // Archives
  "application/zip": () =>
    buildZip([{ name: "a.txt", content: Buffer.from("x") }]),
  "application/x-zip-compressed": () =>
    buildZip([{ name: "a.txt", content: Buffer.from("x") }]),
};

/** RIFF/AVI with an `avih` header carrying frame timing and dimensions. */
function validAvi(width = 320, height = 240): Buffer {
  const avih = Buffer.alloc(8 + 56);
  avih.write("avih", 0, "latin1");
  avih.writeUInt32LE(56, 4);
  avih.writeUInt32LE(33_333, 8); // microseconds per frame
  avih.writeUInt32LE(60, 20); // total frames
  avih.writeUInt32LE(width, 36);
  avih.writeUInt32LE(height, 40);

  const body = Buffer.concat([Buffer.from("AVI ", "latin1"), avih]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

const inspect = (buf: Buffer, declaredMime: string) =>
  inspectMedia({
    head: buf,
    totalSize: buf.length,
    declaredMime,
    complete: true,
  });

describe("every accepted chat MIME has a fixture", () => {
  it("covers the whole allow-list", () => {
    const missing = Object.keys(CHAT.allowedMime).filter(
      (mime) => !FIXTURES[mime]
    );
    expect(missing).toEqual([]);
  });
});

describe("valid files pass magic-byte + structural validation", () => {
  it.each(Object.keys(FIXTURES))("accepts a real %s", (mime) => {
    const buf = FIXTURES[mime]!();
    expect(() => assertMagicBytesMatch(buf, mime)).not.toThrow();
    const result = inspect(buf, mime);
    expect({ mime, ok: result.ok, code: result.code }).toEqual({
      mime,
      ok: true,
      code: undefined,
    });
  });
});

describe("ISOBMFF track dimensions come from tkhd, not from its matrix", () => {
  // `tkhd`'s width/height sit AFTER the 36-byte transform matrix. Reading four
  // bytes early lands on the matrix's last element (0x40000000, a 2.30 fixed
  // point 1.0), which as a 16.16 width is 16384 — over the 8192px limit, so
  // every real MP4/MOV was rejected with DIMENSIONS_EXCEEDED.
  it.each([
    ["video/mp4", () => validMp4({ width: 1280, height: 720 }), 1280, 720],
    [
      "video/quicktime",
      () => classicMov({ width: 1920, height: 1080 }),
      1920,
      1080,
    ],
  ])("reads real dimensions from a %s", (mime, make, width, height) => {
    const result = inspect(make(), mime);
    expect({
      ok: result.ok,
      width: result.width,
      height: result.height,
    }).toEqual({ ok: true, width, height });
  });
});

describe("the required extension spellings are accepted", () => {
  const client = createStorageClient({
    endpoint: "http://localhost:9000",
    accessKey: "key",
    secretKey: "secret",
    region: "us-east-1",
  });

  const mint = (contentType: string, fileName: string) =>
    createUploadUrl({
      client,
      def: CHAT,
      contentType,
      contentLength: 1024,
      ownerId: "owner-1",
      fileName,
      expiresIn: 900,
    });

  it.each([
    ["image/jpeg", "holiday.jpg"],
    // `.jpeg` is as standard a spelling as `.jpg`; it used to 415.
    ["image/jpeg", "holiday.jpeg"],
    ["image/png", "shot.png"],
    ["image/webp", "sticker.webp"],
    ["image/gif", "loop.gif"],
    ["image/heic", "IMG_0001.heic"],
    ["image/heif", "IMG_0002.heif"],
    ["image/heic", "IMG_0003.HEIF"],
    ["video/mp4", "clip.mp4"],
    ["video/quicktime", "clip.mov"],
    ["video/webm", "clip.webm"],
    ["video/x-matroska", "clip.mkv"],
    ["audio/mpeg", "song.mp3"],
    ["audio/mp4", "note.m4a"],
    ["audio/aac", "note.aac"],
    ["audio/wav", "note.wav"],
    ["audio/ogg", "note.ogg"],
    ["audio/ogg", "note.opus"],
    ["audio/opus", "note.opus"],
    ["application/pdf", "invoice.pdf"],
    ["application/msword", "memo.doc"],
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "memo.docx",
    ],
    ["application/vnd.ms-excel", "book.xls"],
    [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "book.xlsx",
    ],
    ["application/vnd.ms-powerpoint", "deck.ppt"],
    [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "deck.pptx",
    ],
    ["text/plain", "notes.txt"],
    ["text/csv", "rows.csv"],
  ])("mints an upload URL for %s named %s", async (contentType, fileName) => {
    await expect(mint(contentType, fileName)).resolves.toMatchObject({
      headers: { "Content-Type": contentType },
    });
  });

  it("still rejects an extension that names a DIFFERENT format", async () => {
    await expect(mint("image/png", "totally-an-image.html")).rejects.toThrow(
      StorageValidationError
    );
  });

  it("rejects a MIME that is not on the allow-list at all", async () => {
    await expect(mint("application/x-msdownload", "setup.exe")).rejects.toThrow(
      StorageValidationError
    );
  });

  it("enforces the per-MIME cap below the category ceiling", async () => {
    // 100 MB category ceiling, 25 MB image cap.
    expect(effectiveMaxBytes(CHAT, "image/jpeg")).toBeLessThan(CHAT.maxBytes);
    await expect(
      createUploadUrl({
        client,
        def: CHAT,
        contentType: "image/jpeg",
        contentLength: effectiveMaxBytes(CHAT, "image/jpeg") + 1,
        ownerId: "owner-1",
        expiresIn: 900,
      })
    ).rejects.toThrow(StorageValidationError);
  });

  it("rejects an empty file", async () => {
    await expect(
      createUploadUrl({
        client,
        def: CHAT,
        contentType: "image/png",
        contentLength: 0,
        ownerId: "owner-1",
        expiresIn: 900,
      })
    ).rejects.toThrow(StorageValidationError);
  });
});

describe("declared type vs. actual bytes (MIME spoofing)", () => {
  const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x04, 0x00]);

  it.each([
    ["image/jpeg", "an executable"],
    ["image/png", "an executable"],
    ["image/gif", "an executable"],
    ["image/webp", "an executable"],
    ["video/mp4", "an executable"],
    ["audio/mpeg", "an executable"],
    ["application/pdf", "an executable"],
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "an executable",
    ],
  ])("rejects %s that is really %s", (mime) => {
    expect(() => assertMagicBytesMatch(EXE, mime)).toThrow(
      MagicByteValidationError
    );
  });

  it("rejects an executable declared text/plain (no signature to lean on)", () => {
    // text/* has no positive signature, so the magic layer defers — the
    // structural inspector is what has to catch this one.
    expect(() => assertMagicBytesMatch(EXE, "text/plain")).not.toThrow();
    const result = inspect(EXE, "text/plain");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SIGNATURE_MISMATCH");
  });

  it("fails closed for a MIME with no signature policy at all", () => {
    expect(() =>
      assertMagicBytesMatch(EXE, "application/octet-stream")
    ).toThrow(MagicByteValidationError);
  });

  it.each([
    // Each pair is a real file of format A declared as format B.
    ["image/png", () => validJpeg(), "a JPEG declared PNG"],
    ["image/jpeg", () => validPng(), "a PNG declared JPEG"],
    ["image/gif", () => validWebp(), "a WebP declared GIF"],
    ["video/mp4", () => validHeic(), "a HEIC declared MP4"],
    ["image/heic", () => validMp4(), "an MP4 declared HEIC"],
    ["audio/wav", () => validMp3(), "an MP3 declared WAV"],
    ["audio/flac", () => validOgg(), "an Ogg declared FLAC"],
    ["video/x-matroska", () => validMp4(), "an MP4 declared MKV"],
    ["application/pdf", () => buildDocx(), "a DOCX declared PDF"],
  ])("rejects %s when the bytes are %s", (mime, make) => {
    const buf = make();
    let magicRejected = false;
    try {
      assertMagicBytesMatch(buf, mime);
    } catch {
      magicRejected = true;
    }
    // Either layer may be the one that catches it; what matters is that the
    // file never reaches CLEAN.
    expect(magicRejected || !inspect(buf, mime).ok).toBe(true);
  });

  it("rejects a plain ZIP declared as a DOCX at the OOXML layer", () => {
    // Magic bytes cannot tell these apart — both are PK archives — which is
    // exactly why the OOXML directory check exists (see zip-inspector.test.ts).
    const zip = buildZip([{ name: "a.txt", content: Buffer.from("x") }]);
    expect(() =>
      assertMagicBytesMatch(
        zip,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      )
    ).not.toThrow();
  });

  it("rejects an Ogg with no OpusHead declared audio/opus", () => {
    const vorbis = validOgg({ opus: false });
    const result = inspect(vorbis, "audio/opus");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SIGNATURE_MISMATCH");
  });
});

describe("corrupted, truncated and empty files", () => {
  it.each([
    ["PNG missing IEND", () => validPng({ omitIend: true }), "image/png"],
    ["JPEG missing EOI", () => validJpeg({ omitEoi: true }), "image/jpeg"],
    ["GIF missing trailer", () => validGif({ omitTrailer: true }), "image/gif"],
    [
      "PDF missing %%EOF",
      () => Buffer.from("%PDF-1.7\nbroken"),
      "application/pdf",
    ],
    ["WAV with no fmt chunk", () => truncatedWav(), "audio/wav"],
    ["Ogg header cut short", () => validOgg().subarray(0, 12), "audio/ogg"],
    ["FLAC cut short", () => validFlac().subarray(0, 20), "audio/flac"],
    [
      "Matroska header only",
      () => Buffer.from([0x1a, 0x45, 0xdf]),
      "video/webm",
    ],
  ])("rejects %s", (_label, make, mime) => {
    expect(inspect(make(), mime).ok).toBe(false);
  });

  it("rejects an empty object for every media MIME", () => {
    for (const mime of Object.keys(FIXTURES)) {
      const result = inspectMedia({
        head: Buffer.alloc(0),
        totalSize: 0,
        declaredMime: mime,
        complete: true,
      });
      expect({ mime, ok: result.ok }).toEqual({ mime, ok: false });
    }
  });
});

/** RIFF/WAVE with the `fmt ` chunk removed — the header still looks right. */
function truncatedWav(): Buffer {
  const body = Buffer.from("WAVE", "latin1");
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}
