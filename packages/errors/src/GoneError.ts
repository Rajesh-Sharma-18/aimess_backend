import { AppError } from "./AppError";

export class GoneError extends AppError {
  constructor(messageKey: string) {
    super(messageKey, 410, messageKey);
  }
}
