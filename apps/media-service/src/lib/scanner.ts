/**
 * Virus / malware scan SEAM. Phase 1 ships the interface and a no-op default so
 * the upload pipeline has a single, swappable extension point; a real engine
 * (ClamAV / cloud scanner) is wired behind this in Phase 2 together with the
 * post-upload confirm step that streams the stored bytes through it.
 *
 * Nothing on the upload-url path invokes a scanner today (the bytes are not
 * present until the client PUTs to MinIO), so this is intentionally not yet
 * called — it exists so future callers and tests can depend on a stable
 * contract. See docs/MEDIA_ARCHITECTURE_REVIEW.md §9 (security) and §13 (Phase 2).
 */

export type MediaScanStatus = "CLEAN" | "INFECTED" | "SKIPPED" | "ERROR";

export interface MediaScanInput {
  bucket: string;
  objectKey: string;
  contentType: string;
}

export interface MediaScanResult {
  status: MediaScanStatus;
  /** Engine-specific detail (signature name on INFECTED, reason on ERROR). */
  details?: string;
}

export interface MediaScanner {
  /**
   * Scan a stored object. Implementations MUST NOT throw — surface failures as
   * `{ status: "ERROR" }` so the caller decides whether to block or allow.
   */
  scan(input: MediaScanInput): Promise<MediaScanResult>;
}

/**
 * Default scanner: a no-op that reports SKIPPED. Keeps the seam wired without a
 * scanning dependency until Phase 2 swaps in a real engine.
 */
export class NoopMediaScanner implements MediaScanner {
  scan(input: MediaScanInput): Promise<MediaScanResult> {
    void input;
    return Promise.resolve({ status: "SKIPPED" });
  }
}

/** The active scanner. Swap this binding when a real engine lands (Phase 2). */
export const mediaScanner: MediaScanner = new NoopMediaScanner();
