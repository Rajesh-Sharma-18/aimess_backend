/**
 * Byte-accurate media fixtures.
 *
 * The old tests fed the validator a bare 8-byte PNG signature and called the
 * result "a valid PNG" — which was true of the check that existed (a prefix
 * compare) and is the whole reason a header-only check is not enough. The deep
 * inspector walks real structure, so the tests must build real structure:
 * an IHDR that declares dimensions, an IEND that ends the file, a JPEG whose
 * markers chain to an EOI, a GIF whose block stream terminates.
 *
 * Everything here is synthesised in-process — no binary test assets in the repo,
 * and each generator takes the parameters (dimensions, frame count, appended
 * payload) that the security limits are expressed in.
 */

// ─── PNG ─────────────────────────────────────────────────────────────────────

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32 (PNG polynomial). Real readers check it; ours does not, but valid
 *  fixtures should still be valid files. */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

export interface PngOptions {
  width?: number;
  height?: number;
  /** Append an APNG animation-control chunk declaring this many frames. */
  frames?: number;
  /** Include an eXIf metadata chunk. */
  exif?: boolean;
  /** Bytes appended AFTER IEND (the polyglot vector). */
  trailing?: Buffer;
  /** Omit the IEND chunk (truncated file). */
  omitIend?: boolean;
}

export function validPng(opts: PngOptions = {}): Buffer {
  const { width = 16, height = 16 } = opts;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const parts: Buffer[] = [PNG_SIG, pngChunk("IHDR", ihdr)];

  if (opts.frames != null) {
    const actl = Buffer.alloc(8);
    actl.writeUInt32BE(opts.frames, 0);
    actl.writeUInt32BE(0, 4); // num_plays
    parts.push(pngChunk("acTL", actl));
  }
  if (opts.exif) {
    parts.push(pngChunk("eXIf", Buffer.from("II*\0\0\0\0\0", "latin1")));
  }
  parts.push(pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00])));
  if (!opts.omitIend) parts.push(pngChunk("IEND", Buffer.alloc(0)));
  if (opts.trailing) parts.push(opts.trailing);
  return Buffer.concat(parts);
}

// ─── JPEG ────────────────────────────────────────────────────────────────────

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.from([0xff, marker]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2, 0);
  return Buffer.concat([head, len, payload]);
}

export interface JpegOptions {
  width?: number;
  height?: number;
  /** Attach an APP1 EXIF block. */
  exif?: boolean;
  /** Attach an APP1 EXIF block that contains a GPS IFD pointer (tag 0x8825). */
  gps?: boolean;
  trailing?: Buffer;
  omitEoi?: boolean;
}

export function validJpeg(opts: JpegOptions = {}): Buffer {
  const { width = 16, height = 16 } = opts;
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])]; // SOI

  if (opts.exif || opts.gps) {
    parts.push(jpegSegment(0xe1, buildExif(opts.gps === true)));
  }

  // SOF0: precision, height, width, components…
  const sof = Buffer.alloc(6 + 3);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 1; // one component
  parts.push(jpegSegment(0xc0, sof));

  // SOS followed by a scrap of entropy-coded data.
  parts.push(
    jpegSegment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]))
  );
  parts.push(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]));

  if (!opts.omitEoi) parts.push(Buffer.from([0xff, 0xd9])); // EOI
  if (opts.trailing) parts.push(opts.trailing);
  return Buffer.concat(parts);
}

/** Minimal little-endian TIFF/EXIF block, optionally carrying a GPS IFD entry. */
function buildExif(withGps: boolean): Buffer {
  const entries: Buffer[] = [];
  const entry = (tag: number): Buffer => {
    const b = Buffer.alloc(12);
    b.writeUInt16LE(tag, 0);
    b.writeUInt16LE(4, 2); // LONG
    b.writeUInt32LE(1, 4);
    b.writeUInt32LE(0, 8);
    return b;
  };
  entries.push(entry(0x010e)); // ImageDescription
  if (withGps) entries.push(entry(0x8825)); // GPS IFD pointer

  const tiff = Buffer.alloc(8 + 2 + entries.length * 12 + 4);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 offset
  tiff.writeUInt16LE(entries.length, 8);
  Buffer.concat(entries).copy(tiff, 10);
  return Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
}

// ─── GIF ─────────────────────────────────────────────────────────────────────

export interface GifOptions {
  width?: number;
  height?: number;
  frames?: number;
  version?: "GIF87a" | "GIF89a";
  trailing?: Buffer;
  omitTrailer?: boolean;
}

export function validGif(opts: GifOptions = {}): Buffer {
  const { width = 8, height = 8, frames = 1, version = "GIF89a" } = opts;
  const header = Buffer.alloc(13);
  header.write(version, 0, "latin1");
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  header[10] = 0x00; // no global colour table
  const parts: Buffer[] = [header];

  for (let i = 0; i < frames; i++) {
    const desc = Buffer.alloc(10);
    desc[0] = 0x2c;
    desc.writeUInt16LE(0, 1);
    desc.writeUInt16LE(0, 3);
    desc.writeUInt16LE(width, 5);
    desc.writeUInt16LE(height, 7);
    desc[9] = 0x00; // no local colour table
    // LZW min code size + one sub-block + terminator
    parts.push(desc, Buffer.from([0x02, 0x02, 0x4c, 0x01, 0x00]));
  }
  if (!opts.omitTrailer) parts.push(Buffer.from([0x3b]));
  if (opts.trailing) parts.push(opts.trailing);
  return Buffer.concat(parts);
}

// ─── WebP ────────────────────────────────────────────────────────────────────

export function validWebp(width = 16, height = 16): Buffer {
  // VP8L lossless: 1 signature byte + 4 bytes packing (14-bit w-1, 14-bit h-1).
  const payload = Buffer.alloc(5);
  payload[0] = 0x2f;
  payload.writeUInt32LE(((height - 1) << 14) | (width - 1), 1);

  const chunk = Buffer.alloc(8 + payload.length);
  chunk.write("VP8L", 0, "latin1");
  chunk.writeUInt32LE(payload.length, 4);
  payload.copy(chunk, 8);

  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(4 + chunk.length, 4);
  riff.write("WEBP", 8, "latin1");
  return Buffer.concat([riff, chunk]);
}

// ─── ISO base media (MP4 / HEIC) ─────────────────────────────────────────────

function box(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}

/** `ftyp` with the given major brand + compatible brands. */
export function isobmffFtyp(major: string, compatible: string[] = []): Buffer {
  const body = Buffer.concat([
    Buffer.from(major.padEnd(4, " "), "latin1"),
    Buffer.from([0, 0, 0, 0]), // minor version
    ...compatible.map((b) => Buffer.from(b.padEnd(4, " "), "latin1")),
  ]);
  return box("ftyp", body);
}

/** MP4 with a v0 `mvhd` declaring `durationMs`, and a `tkhd` with dimensions. */
export function validMp4(
  opts: {
    durationMs?: number;
    width?: number;
    height?: number;
    brand?: string;
  } = {}
): Buffer {
  const {
    durationMs = 5_000,
    width = 640,
    height = 480,
    brand = "isom",
  } = opts;
  const timescale = 1000;

  const mvhd = Buffer.alloc(100);
  mvhd[0] = 0; // version 0
  mvhd.writeUInt32BE(timescale, 12);
  mvhd.writeUInt32BE(Math.round((durationMs / 1000) * timescale), 16);

  const tkhd = Buffer.alloc(84);
  tkhd[0] = 0; // version 0 → 80-byte body, w/h in the last 8 bytes
  tkhd.writeUInt32BE(width * 65536, 80 - 8);
  tkhd.writeUInt32BE(height * 65536, 80 - 4);

  const trak = box("trak", box("tkhd", tkhd.subarray(0, 80)));
  const moov = box("moov", Buffer.concat([box("mvhd", mvhd), trak]));
  return Buffer.concat([isobmffFtyp(brand, ["isom", "mp42"]), moov]);
}

/** HEIC still: same container, HEIF brand, dimensions in `meta/iprp/ipco/ispe`. */
export function validHeic(width = 4032, height = 3024): Buffer {
  const ispeBody = Buffer.alloc(12);
  ispeBody.writeUInt32BE(0, 0); // version + flags
  ispeBody.writeUInt32BE(width, 4);
  ispeBody.writeUInt32BE(height, 8);
  const ipco = box("ipco", box("ispe", ispeBody));
  const iprp = box("iprp", ipco);
  // `meta` is a FullBox — 4 bytes of version+flags before its children.
  const meta = box("meta", Buffer.concat([Buffer.alloc(4), iprp]));
  return Buffer.concat([isobmffFtyp("heic", ["mif1", "heic"]), meta]);
}

// ─── ZIP ─────────────────────────────────────────────────────────────────────

export interface ZipEntrySpec {
  name: string;
  /** Uncompressed size to DECLARE (drives the bomb-ratio check). */
  uncompressedSize?: number;
  content?: Buffer;
  /** Set general-purpose flag bit 0 (encrypted). */
  encrypted?: boolean;
  /** Set general-purpose flag bit 3 (sizes live in a trailing data descriptor). */
  dataDescriptor?: boolean;
  /** Compression method; 0 = STORED, 8 = DEFLATE. */
  method?: number;
}

/**
 * Build a ZIP with a real local-header section AND a real central directory, so
 * the inspector's central-directory walk has something to walk. Sizes in the
 * central directory can be forged independently of the actual content, which is
 * what makes bomb-ratio testing possible without shipping a bomb.
 */
export function buildZip(entries: ZipEntrySpec[], comment = ""): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const spec of entries) {
    const name = Buffer.from(spec.name, "utf8");
    const content = spec.content ?? Buffer.alloc(0);
    const declared = spec.uncompressedSize ?? content.length;
    const flags =
      (spec.encrypted ? 0x0001 : 0) | (spec.dataDescriptor ? 0x0008 : 0);
    const method = spec.method ?? 0;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(flags, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(spec.dataDescriptor ? 0 : content.length, 18);
    lfh.writeUInt32LE(spec.dataDescriptor ? 0 : declared, 22);
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28);
    locals.push(lfh, name, content);

    const cdfh = Buffer.alloc(46);
    cdfh.writeUInt32LE(0x02014b50, 0);
    cdfh.writeUInt16LE(20, 4);
    cdfh.writeUInt16LE(20, 6);
    cdfh.writeUInt16LE(flags, 8);
    cdfh.writeUInt16LE(method, 10);
    cdfh.writeUInt32LE(content.length, 20);
    cdfh.writeUInt32LE(declared, 24);
    cdfh.writeUInt16LE(name.length, 28);
    cdfh.writeUInt32LE(offset, 42);
    centrals.push(cdfh, name);

    offset += lfh.length + name.length + content.length;
  }

  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(centrals);
  const commentBuf = Buffer.from(comment, "utf8");

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localBytes.length, 16);
  eocd.writeUInt16LE(commentBuf.length, 20);

  return Buffer.concat([localBytes, centralBytes, eocd, commentBuf]);
}

/** A DOCX-shaped OOXML package. `extraEntries` can smuggle in active content. */
export function buildDocx(extraEntries: ZipEntrySpec[] = []): Buffer {
  return buildZip([
    { name: "[Content_Types].xml", content: Buffer.from("<Types/>") },
    { name: "word/document.xml", content: Buffer.from("<w:document/>") },
    ...extraEntries,
  ]);
}

/** The EICAR antivirus test string — a real signature, harmless bytes. */
export const EICAR = Buffer.from(
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
  "latin1"
);
