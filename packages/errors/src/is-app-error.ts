import { AppError } from "./AppError";

/** Works across duplicate `@aimess/errors` installs in monorepos. */
export function isAppError(error: unknown): error is AppError {
  if (error instanceof AppError) {
    return true;
  }

  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    "isOperational" in error &&
    typeof (error as AppError).statusCode === "number"
  );
}
