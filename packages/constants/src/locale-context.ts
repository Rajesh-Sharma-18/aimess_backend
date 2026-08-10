import { AsyncLocalStorage } from "node:async_hooks";

import { DEFAULT_LOCALE, type SupportedLocale } from "./locale.js";

/**
 * Ambient per-request locale.
 *
 * The problem this solves: the locale enters the process at ONE edge (the
 * `x-lang` / `Accept-Language` header, or a socket handshake), but the code
 * that finally renders a sentence — a message serializer five layers down a
 * service, a gRPC handler in another process — is nowhere near that edge.
 * Threading a `locale` argument through every signature in between is a large,
 * permanently-growing diff for a value that behaves exactly like a request
 * header.
 *
 * So it rides an AsyncLocalStorage instead: set once at the edge
 * ({@link runWithLocale}), read wherever it is needed ({@link currentLocale}),
 * and carried across the gateway → service gRPC hop as an `x-lang` metadata
 * header (see `@aimess/grpc-utils`).
 *
 * Explicit `locale` parameters still win everywhere they exist — this is the
 * fallback for code that cannot reasonably be given one, never a replacement
 * for passing it.
 */
const localeStore = new AsyncLocalStorage<SupportedLocale>();

/** Run `fn` with `locale` visible to every async continuation inside it. */
export function runWithLocale<T>(locale: SupportedLocale, fn: () => T): T {
  return localeStore.run(locale, fn);
}

/** Locale of the in-flight request, or `fallback` outside any request. */
export function currentLocale(
  fallback: SupportedLocale = DEFAULT_LOCALE
): SupportedLocale {
  return localeStore.getStore() ?? fallback;
}
