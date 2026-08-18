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

  // tkhd, version 0: an 84-byte body whose last 8 bytes are width/height as
  // 16.16 fixed point, preceded by the 36-byte transform matrix at offset 40.
  //
  // This fixture used to declare an 80-byte body and write the dimensions at
  // 72/76 — matching what the parser read rather than what the format says, so
  // it agreed with an off-by-four bug instead of catching it. The matrix is now
  // populated with the real identity values, which is what makes that bug
  // visible: its last element is 0x40000000, and reading it as a 16.16 width
  // yields 16384.
  const tkhd = Buffer.alloc(84);
  tkhd[0] = 0; // version 0
  const MATRIX_AT = 40;
  tkhd.writeUInt32BE(0x0001_0000, MATRIX_AT); // a = 1.0 (16.16)
  tkhd.writeUInt32BE(0x0001_0000, MATRIX_AT + 16); // d = 1.0 (16.16)
  tkhd.writeUInt32BE(0x4000_0000, MATRIX_AT + 32); // w = 1.0 (2.30)
  tkhd.writeUInt32BE(width * 65536, 84 - 8);
  tkhd.writeUInt32BE(height * 65536, 84 - 4);

  const trak = box("trak", box("tkhd", tkhd));
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

/** `.m4a` audio: same ISOBMFF container, `M4A ` brand, no visual track. */
export function validM4a(durationMs = 4_000): Buffer {
  const timescale = 1000;
  const mvhd = Buffer.alloc(100);
  mvhd[0] = 0; // version 0
  mvhd.writeUInt32BE(timescale, 12);
  mvhd.writeUInt32BE(Math.round((durationMs / 1000) * timescale), 16);
  const moov = box("moov", box("mvhd", mvhd));
  return Buffer.concat([isobmffFtyp("M4A ", ["mp42", "isom"]), moov]);
}

/**
 * A `.mov` as QuickTime Player and several screen recorders emit it: NO `ftyp`
 * box at all, the first atom is `wide`/`moov`/`mdat`. Valid `video/quicktime`
 * that matched no signature before `isClassicQuickTime` existed.
 */
export function classicMov(
  opts: { durationMs?: number; width?: number; height?: number } = {}
): Buffer {
  const withFtyp = validMp4({ ...opts, brand: "qt  " });
  const ftypLen = withFtyp.readUInt32BE(0);
  const wide = Buffer.alloc(8);
  wide.writeUInt32BE(8, 0);
  wide.write("wide", 4, "latin1");
  return Buffer.concat([wide, withFtyp.subarray(ftypLen)]);
}

// ─── Matroska / WebM ─────────────────────────────────────────────────────────

/** EBML element: id bytes (already marker-encoded) + a 1-byte size vint + body. */
function ebml(id: number[], body: Buffer): Buffer {
  if (body.length > 126) throw new Error("fixture EBML body too large");
  return Buffer.concat([
    Buffer.from(id),
    Buffer.from([0x80 | body.length]),
    body,
  ]);
}

const f64 = (value: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(value, 0);
  return b;
};

export function validMatroska(
  opts: {
    docType?: "matroska" | "webm";
    width?: number;
    height?: number;
    /** Duration in TimecodeScale ticks; with the default scale these are ms. */
    durationMs?: number;
  } = {}
): Buffer {
  const {
    docType = "matroska",
    width = 640,
    height = 480,
    durationMs = 8_000,
  } = opts;

  const header = ebml(
    [0x1a, 0x45, 0xdf, 0xa3],
    ebml([0x42, 0x82], Buffer.from(docType, "latin1"))
  );
  const info = ebml(
    [0x15, 0x49, 0xa9, 0x66],
    Buffer.concat([
      ebml([0x2a, 0xd7, 0xb1], Buffer.from([0x0f, 0x42, 0x40])), // 1_000_000
      ebml([0x44, 0x89], f64(durationMs)),
    ])
  );
  const video = ebml(
    [0xe0],
    Buffer.concat([ebml([0xb0], uintBE(width)), ebml([0xba], uintBE(height))])
  );
  const tracks = ebml([0x16, 0x54, 0xae, 0x6b], ebml([0xae], video));
  const segment = ebml([0x18, 0x53, 0x80, 0x67], Buffer.concat([info, tracks]));
  return Buffer.concat([header, segment]);
}

/** Big-endian unsigned int in the fewest bytes EBML needs. */
function uintBE(value: number): Buffer {
  const bytes: number[] = [];
  let v = value;
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return Buffer.from(bytes);
}

// ─── WAV / MP3 / AAC / Ogg / FLAC ────────────────────────────────────────────

function riffChunk(id: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(id, 0, "latin1");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([
    head,
    body,
    body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0),
  ]);
}

export function validWav(durationMs = 2_000): Buffer {
  const byteRate = 44_100 * 2 * 2; // 44.1 kHz, stereo, 16-bit
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); // PCM
  fmt.writeUInt16LE(2, 2); // channels
  fmt.writeUInt32LE(44_100, 4);
  fmt.writeUInt32LE(byteRate, 8);
  fmt.writeUInt16LE(4, 12);
  fmt.writeUInt16LE(16, 14);
  // The `data` chunk declares its own size; the inspector derives duration from
  // that declaration, so the fixture need not carry the actual samples.
  const dataSize = Math.round((durationMs / 1000) * byteRate);
  const data = Buffer.alloc(8);
  data.write("data", 0, "latin1");
  data.writeUInt32LE(dataSize, 4);

  const body = Buffer.concat([
    Buffer.from("WAVE", "latin1"),
    riffChunk("fmt ", fmt),
    data,
  ]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

/** MPEG-1 Layer III, 128 kbps, 44.1 kHz — optionally behind an ID3v2 tag. */
export function validMp3(
  opts: { id3?: boolean; frames?: number } = {}
): Buffer {
  const parts: Buffer[] = [];
  if (opts.id3) {
    const tag = Buffer.alloc(10 + 16);
    tag.write("ID3", 0, "latin1");
    tag[3] = 3; // version
    tag[9] = 16; // syncsafe size of the (empty) tag body
    parts.push(tag);
  }
  const frame = Buffer.alloc(417); // 128 kbps @ 44.1 kHz frame size
  frame[0] = 0xff;
  frame[1] = 0xfb; // MPEG1 Layer III, no CRC
  frame[2] = 0x90; // bitrate index 9 (128k), sample-rate index 0 (44.1k)
  frame[3] = 0xc4;
  for (let i = 0; i < (opts.frames ?? 2); i++) parts.push(frame);
  return Buffer.concat(parts);
}

/** Raw AAC: two CHAINED ADTS frames — the second sync word must land exactly
 *  where the first frame's declared length says it will. */
export function validAac(frameLen = 64): Buffer {
  const frame = (): Buffer => {
    const b = Buffer.alloc(frameLen);
    b[0] = 0xff;
    b[1] = 0xf1; // MPEG-4, no CRC
    b[2] = 0x50;
    b[3] = 0x80 | ((frameLen >> 11) & 0x03);
    b[4] = (frameLen >> 3) & 0xff;
    b[5] = ((frameLen & 0x07) << 5) | 0x1f;
    b[6] = 0xfc;
    return b;
  };
  return Buffer.concat([frame(), frame(), frame()]);
}

/** One Ogg page: 27-byte header + a single segment carrying `payload`. */
function oggPage(payload: Buffer, granule: number, seq: number): Buffer {
  const segments = Math.ceil(payload.length / 255) || 1;
  const header = Buffer.alloc(27 + segments);
  header.write("OggS", 0, "latin1");
  header[4] = 0; // stream structure version
  header[5] = seq === 0 ? 0x02 : 0x00; // BOS on the first page
  header.writeUInt32LE(granule >>> 0, 6);
  header.writeUInt32LE(Math.floor(granule / 0x1_0000_0000), 10);
  header.writeUInt32LE(0xdeadbeef, 14); // stream serial
  header.writeUInt32LE(seq, 18);
  header.writeUInt32LE(0, 22); // CRC — not verified by the inspector
  header[26] = segments;
  let left = payload.length;
  for (let i = 0; i < segments; i++) {
    header[27 + i] = Math.min(255, left);
    left -= 255;
  }
  return Buffer.concat([header, payload]);
}

/**
 * Ogg stream. `opus: true` puts an `OpusHead` identification packet in the first
 * page — which is what makes an `audio/opus` declaration verifiable rather than
 * merely container-shaped.
 */
export function validOgg(
  opts: { opus?: boolean; durationMs?: number } = {}
): Buffer {
  const { opus = true, durationMs = 3_000 } = opts;
  const idPacket = opus
    ? Buffer.concat([
        Buffer.from("OpusHead", "latin1"),
        Buffer.from([1, 2, 0x38, 0x01, 0x80, 0xbb, 0x00, 0x00, 0, 0, 0]),
      ])
    : Buffer.concat([
        Buffer.from([0x01]),
        Buffer.from("vorbis", "latin1"),
        (() => {
          const b = Buffer.alloc(23);
          b.writeUInt32LE(44_100, 5); // sample rate at offset 12 of the packet
          return b;
        })(),
      ]);
  // Opus granule positions are always counted in 48 kHz units.
  const granule = Math.round((durationMs / 1000) * 48_000);
  return Buffer.concat([
    oggPage(idPacket, 0, 0),
    oggPage(Buffer.alloc(32), granule, 1),
  ]);
}

export function validFlac(durationMs = 2_000): Buffer {
  const sampleRate = 44_100;
  const totalSamples = Math.round((durationMs / 1000) * sampleRate);
  const streaminfo = Buffer.alloc(34);
  // sample rate: 20 bits starting at byte 10; channels/bps share byte 12.
  streaminfo[10] = (sampleRate >> 12) & 0xff;
  streaminfo[11] = (sampleRate >> 4) & 0xff;
  streaminfo[12] =
    ((sampleRate & 0x0f) << 4) | ((totalSamples / 0x1_0000_0000) & 0x0f);
  streaminfo[13] = (totalSamples >>> 24) & 0xff;
  streaminfo[14] = (totalSamples >>> 16) & 0xff;
  streaminfo[15] = (totalSamples >>> 8) & 0xff;
  streaminfo[16] = totalSamples & 0xff;

  const blockHeader = Buffer.alloc(4);
  blockHeader[0] = 0x80; // last-metadata-block flag, type 0 = STREAMINFO
  blockHeader.writeUIntBE(streaminfo.length, 1, 3);
  return Buffer.concat([
    Buffer.from("fLaC", "latin1"),
    blockHeader,
    streaminfo,
  ]);
}

// ─── Documents ───────────────────────────────────────────────────────────────

/** Minimal well-formed PDF. `body` can smuggle in active-content markers. */
export function validPdf(body = "1 0 obj<</Type/Catalog>>endobj"): Buffer {
  return Buffer.from(`%PDF-1.7\n${body}\n%%EOF`);
}

/**
 * Legacy Office (DOC / XLS / PPT) — Compound File Binary. All three share one
 * signature, which is exactly why the pipeline treats them as a single family.
 */
export function validCompoundOffice(): Buffer {
  const b = Buffer.alloc(512);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(b, 0);
  return b;
}

/** An XLSX-shaped OOXML package (identified by `xl/workbook.xml`). */
export function buildXlsx(extraEntries: ZipEntrySpec[] = []): Buffer {
  return buildZip([
    { name: "[Content_Types].xml", content: Buffer.from("<Types/>") },
    { name: "xl/workbook.xml", content: Buffer.from("<workbook/>") },
    ...extraEntries,
  ]);
}

/** A PPTX-shaped OOXML package (identified by `ppt/presentation.xml`). */
export function buildPptx(extraEntries: ZipEntrySpec[] = []): Buffer {
  return buildZip([
    { name: "[Content_Types].xml", content: Buffer.from("<Types/>") },
    { name: "ppt/presentation.xml", content: Buffer.from("<presentation/>") },
    ...extraEntries,
  ]);
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
