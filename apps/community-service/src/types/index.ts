/** HTTP payloads, DTOs, and shared typing for this service. */
export type ApiSuccess<T> = {
  success: true;
  data: T;
};
