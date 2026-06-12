/**
 * Canonical MinIO key-prefix → logical-bucket mapping for AIMess media.
 *
 * Every stored object key begins with one of these prefixes, and the prefix
 * decides which bucket the object lives in. This map was previously
 * hand-redeclared in chat-service (`media-resolve.ts`), community-service
 * (`community-image.service.ts`), and backoffice-service (the community/group
 * gRPC repositories) — four copies that would silently drift. Per the Unified
 * Media Contract, the mapping lives here so every consumer shares one source of
 * truth.
 *
 * Bucket *names* are intentionally NOT hard-coded here: each service reads its
 * own `MINIO_BUCKET*` env vars and passes them to {@link bucketForKey}, keeping
 * this package free of any service's environment.
 */
export interface MediaPrefixMap {
  /** Shared avatars bucket: user avatars (`avatars/`) + group logos (`group-avatars/`). */
  readonly avatars: readonly string[];
  /**
   * User/member-avatar-only contexts (`avatars/`). Deliberately the NARROWER
   * sibling of {@link MediaPrefixMap.avatars}: it must REJECT `group-avatars/`
   * keys, so it is used wherever a value is known to be a user/member avatar
   * (profile, friends, discovery, admin user list) rather than a group logo.
   */
  readonly userAvatars: readonly string[];
  /** Community bucket: community avatar + cover images. */
  readonly community: readonly string[];
  /** Chat bucket: private / group / community chat attachments. */
  readonly chat: readonly string[];
}

export const MEDIA_PREFIXES: MediaPrefixMap = {
  avatars: ["avatars", "group-avatars"],
  userAvatars: ["avatars"],
  community: ["community/avatar", "community/cover"],
  chat: ["chat-uploads", "group-chat-uploads", "community-chat-uploads"],
};

export interface BucketForKeyOptions {
  /** Bucket for `avatars/` + `group-avatars/` keys. */
  avatarsBucket: string;
  /** Bucket for `community/avatar/` + `community/cover/` keys. */
  communityBucket: string;
  /** Bucket for chat-upload keys and any unrecognized key. */
  chatBucket: string;
}

/**
 * Pick the bucket a stored object key belongs to from its leading prefix.
 *
 *  - `avatars/…`, `group-avatars/…`            → `avatarsBucket`
 *  - `community/avatar/…`, `community/cover/…` → `communityBucket`
 *  - everything else (`chat-uploads/`,
 *    `group-chat-uploads/`, `community-chat-uploads/`
 *    and any unrecognized key)                  → `chatBucket`
 *
 * Mirrors the historical chat-service `bucketForKey`: avatar prefixes match on
 * the leading path SEGMENT, community prefixes match on a `prefix/` boundary
 * (they carry an inner slash, so the top segment is just `community`), and
 * anything unrecognized falls through to the chat bucket so a read/broadcast
 * never throws on an unexpected key.
 */
export function bucketForKey(key: string, opts: BucketForKeyOptions): string {
  const top = key.split("/", 1)[0];
  if (MEDIA_PREFIXES.avatars.includes(top)) {
    return opts.avatarsBucket;
  }
  if (MEDIA_PREFIXES.community.some((prefix) => key.startsWith(`${prefix}/`))) {
    return opts.communityBucket;
  }
  return opts.chatBucket;
}
