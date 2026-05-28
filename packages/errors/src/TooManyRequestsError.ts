import { AppError } from "./AppError";

export class TooManyRequestsError extends AppError {
  constructor(messageKey: string) {
    super(messageKey, 429, messageKey);
  }
}
