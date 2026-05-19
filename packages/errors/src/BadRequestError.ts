import { AppError } from "./AppError";

export class BadRequestError extends AppError {
  constructor(messageKey: string) {
    super(messageKey, 400, messageKey);
  }
}
