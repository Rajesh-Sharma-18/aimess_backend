import { AppError } from "./AppError";

export class ForbiddenError extends AppError {
  constructor(messageKey: string) {
    super(messageKey, 403, messageKey);
  }
}
