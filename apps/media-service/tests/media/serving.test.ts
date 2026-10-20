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

  it("names the forced download after the original file (AIMESS-435)", () => {
    expect(dispositionForKey("chat-uploads/u/abc.pdf", "Q3 report.pdf")).toBe(
      `attachment; filename="Q3 report.pdf"; filename*=UTF-8''Q3%20report.pdf`
    );
    expect(dispositionForKey("chat-uploads/u/abc.pdf", "báo cáo (1).pdf")).toBe(
      `attachment; filename="b_o c_o (1).pdf"; filename*=UTF-8''b%C3%A1o%20c%C3%A1o%20%281%29.pdf`
    );
  });

  it("never lets a filename break the header or escape its directory", () => {
    expect(dispositionForKey("chat-uploads/u/abc.txt", '../x"\r\nSet-Cookie: a.txt')).toBe(
      `attachment; filename="xSet-Cookie: a.txt"; filename*=UTF-8''xSet-Cookie%3A%20a.txt`
    );
    expect(dispositionForKey("chat-uploads/u/abc.txt", "  ")).toBe("attachment");
    expect(dispositionForKey("chat-uploads/u/abc.mp4", "clip.mp4")).toBeUndefined();
  });
});
