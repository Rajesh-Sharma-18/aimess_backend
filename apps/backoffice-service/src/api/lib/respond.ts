import { ApiResponse } from "@aimess/utils";

/**
 * `ApiResponse` with backoffice's top-level siblings preserved.
 *
 * Every other service nests its page metadata inside `data`
 * (`new ApiResponse({ pagination, data }, ...)` — see community-service), but
 * backoffice has always answered `{ success, data, pagination }` with
 * `pagination` as a ROOT key, on 21 list endpoints. Moving it under `data`
 * would be a silent breaking change for every admin-panel table for no
 * functional gain, so the shape is kept and only the missing `message` is
 * added.
 *
 * The spread is `toJSON()`, not the instance: `ApiResponse` serializes Dates to
 * epoch milliseconds in `toJSON`, and spreading the object itself would skip
 * that and emit ISO strings instead.
 */
export function apiResponseWith<T>(
  data: T,
  message: string,
  siblings: Record<string, unknown>
): Record<string, unknown> {
  return { ...new ApiResponse(data, message).toJSON(), ...siblings };
}

/** `{ success, message, data, pagination }` — the backoffice list envelope. */
export function paginated<T>(
  data: T,
  pagination: unknown,
  message: string
): Record<string, unknown> {
  return apiResponseWith(data, message, { pagination });
}
