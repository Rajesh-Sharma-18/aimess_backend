export type StorageValidationCode =
  | "UNSUPPORTED_CONTENT_TYPE"
  | "FILE_EMPTY"
  | "FILE_TOO_LARGE";

/** Raised by storage validators; services map the code to their own error. */
export class StorageValidationError extends Error {
  readonly code: StorageValidationCode;

  constructor(code: StorageValidationCode) {
    super(code);
    this.name = "StorageValidationError";
    this.code = code;
  }
}
