import { AppError } from "./AppError";

export class ConflictError extends AppError {
  constructor(messageKey: string) {
    super(messageKey, 409, messageKey);
  }
}
