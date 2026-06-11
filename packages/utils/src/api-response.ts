function serializeDates(value: unknown): unknown {
  if (value instanceof Date) return value.getTime();
  if (Array.isArray(value)) return value.map(serializeDates);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      result[key] = serializeDates((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

export class ApiResponse<T> {
  success: boolean;
  message?: string;
  data?: T;
  constructor(data?: T, message?: string) {
    this.success = true;
    this.message = message;
    this.data = data;
  }

  toJSON() {
    return {
      success: this.success,
      message: this.message,
      data: serializeDates(this.data),
    };
  }
}
