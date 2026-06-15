/**
 * Safe-serving: dispositionForKey decides inline vs forced-download purely from
 * the object key's extension. Media kinds render inline; everything else (docs,
 * text, data, unknown) is forced to download so an uploaded HTML/SVG/XML payload
 * can never execute inline from our origin.
 */
import { dispositionForKey } from "../../src/config/uploads.js";

describe("dispositionForKey", () => {
  it("returns undefined (inline) for image/video/audio keys", () => {
    for (const ext of [
      "jpg",
      "png",
      "webp",
      "gif",
      "mp4",
      "webm",
      "mp3",
      "flac",
      "m4a",
    ]) {
      expect(dispositionForKey(`chat-uploads/u/abc.${ext}`)).toBeUndefined();
    }
  });

  it("forces attachment for documents and inline-executable types", () => {
    for (const ext of [
      "pdf",
      "docx",
      "xlsx",
      "csv",
      "txt",
      "json",
      "xml",
      "html",
    ]) {
      expect(dispositionForKey(`chat-uploads/u/abc.${ext}`)).toBe("attachment");
    }
  });

  it("forces attachment when the key has no extension", () => {
    expect(dispositionForKey("chat-uploads/u/noext")).toBe("attachment");
  });

  it("is case-insensitive on the extension", () => {
    expect(dispositionForKey("chat-uploads/u/PHOTO.JPG")).toBeUndefined();
    expect(dispositionForKey("chat-uploads/u/REPORT.PDF")).toBe("attachment");
  });
});
