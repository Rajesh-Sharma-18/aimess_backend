/**
 * Centralized deep-link builder for the AIMess `aimess://` URL scheme.
 *
 * All functions are pure and safe to call with any string — no exceptions are
 * thrown and no imports are required.
 */

export type DeepLinkType =
  | "conversation"
  | "community"
  | "communities"
  | "group"
  | "call"
  | "user"
  | "stream";

/**
 * Build a canonical deep-link URL.
 *
 * Overloads:
 *   buildDeepLink('conversation', id)              → aimess://conversation/{id}
 *   buildDeepLink('community', id)                 → aimess://community/{id}
 *   buildDeepLink('community', id, msgId)          → aimess://community/{id}?msgId={msgId}
 *   buildDeepLink('communities')                   → aimess://communities
 *   buildDeepLink('group', id)                     → aimess://group/{id}
 *   buildDeepLink('call', id)                      → aimess://call/{id}
 *   buildDeepLink('user', id)                      → aimess://user/{id}
 *   buildDeepLink('stream', id)                    → aimess://stream/{id}
 */
export function buildDeepLink(type: "conversation", id: string): string;
export function buildDeepLink(
  type: "community",
  id: string,
  msgId?: string
): string;
export function buildDeepLink(type: "communities"): string;
export function buildDeepLink(type: "group", id: string): string;
export function buildDeepLink(type: "call", id: string): string;
export function buildDeepLink(type: "user", id: string): string;
export function buildDeepLink(type: "stream", id: string): string;
export function buildDeepLink(
  type: DeepLinkType,
  id?: string,
  msgId?: string
): string {
  switch (type) {
    case "communities":
      return "aimess://communities";

    case "community": {
      const base = `aimess://community/${id ?? ""}`;
      return msgId ? `${base}?msgId=${msgId}` : base;
    }

    default:
      // conversation, group, call, user, stream — all follow aimess://<type>/<id>
      return `aimess://${type}/${id ?? ""}`;
  }
}
