import { redis } from "../config/redis.js";
import { pushTag } from "./push-tags.js";

/** Same lifetime as the card itself (the FCM TTL); an ended stream's tag is harmless to close again. */
const LIVE_TTL_SEC = 86_400;

const key = (communityId: string) => `notif:livestream:community:${communityId}`;

/** Remember a stream whose "is live" card went out, so leaving / reading the community can close it. */
export async function trackLiveStream(
  communityId: string,
  livestreamId: string
): Promise<void> {
  try {
    await redis.sadd(key(communityId), livestreamId);
    await redis.expire(key(communityId), LIVE_TTL_SEC);
  } catch {
    // Best-effort: the card still closes on the stream's own end.
  }
}

/** `live:<streamId>` tags of the community's recent streams. */
export async function liveStreamTags(communityId: string): Promise<string[]> {
  try {
    const ids = await redis.smembers(key(communityId));
    return (ids ?? []).map(pushTag.live);
  } catch {
    return [];
  }
}
