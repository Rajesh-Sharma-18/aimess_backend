import { AppError } from "./AppError";

export class UnauthorizedError extends AppError {
  constructor(messageKey: string) {
    super(messageKey, 401, messageKey);
  }
}
