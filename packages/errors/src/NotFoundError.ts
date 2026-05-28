import { AppError } from "./AppError";

export class NotFoundError extends AppError {
  constructor(messageKey: string) {
    super(messageKey, 404, messageKey);
  }
}
