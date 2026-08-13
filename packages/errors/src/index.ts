export { AppError } from "./AppError";
export { isAppError } from "./is-app-error";

export { BadRequestError } from "./BadRequestError";
export { UnauthorizedError } from "./UnauthorizedError";
export { ForbiddenError } from "./ForbiddenError";
export { NotFoundError } from "./NotFoundError";
export { ConflictError } from "./ConflictError";
export { GoneError } from "./GoneError";
export { TooManyRequestsError } from "./TooManyRequestsError";
export { UnsupportedMediaTypeError } from "./UnsupportedMediaTypeError";
// Existed as a file since the media-registry work but was never re-exported,
// so every caller that wanted a 503 threw a bare 500 instead.
export { ServiceUnavailableError } from "./ServiceUnavailableError";

export {
  API_ERROR_CODES,
  isRetryableStatus,
  resolveErrorCode,
  type ApiErrorCode,
} from "./error-codes";
