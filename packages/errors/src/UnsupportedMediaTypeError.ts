import { AppError } from "./AppError";

export class UnsupportedMediaTypeError extends AppError {
  constructor(messageKey: string) {
    super(messageKey, 415, messageKey);
  }
}
