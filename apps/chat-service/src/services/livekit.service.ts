import { AccessToken, TrackSource } from "livekit-server-sdk";
import { env } from "../config/env.js";
import { CallType } from "../types/enums.js";

export interface LiveKitCredentials {
  url: string;
  token: string;
}

/**
 * What a participant may publish, by call type.
 *
 * Without `canPublishSources` a grant is a bare `canPublish: true`, which means
 * "any track kind" — so a VOICE call's token let either side push a camera feed
 * or an entire desktop into the room, and nothing server-side could refuse it.
 * The call's own `type` is recorded on the row and drives the UI and the
 * timeline card, but it never reached the token.
 *
 * CAMERA stays allowed on an AUDIO call, deliberately. iOS upgrades voice to
 * video entirely client-side (`LiveKitCallSignalingService.upgradeToVideo`) and
 * never tells the backend, so `Call.type` stays "AUDIO" for the whole call —
 * denying camera here would break every mid-call upgrade. SCREEN_SHARE is
 * denied there because no client implements screen sharing at all, so the
 * restriction costs nothing today and closes the larger hole.
 *
 * Listing sources explicitly also denies anything LiveKit adds to the enum
 * later, which is the direction this should fail.
 *
 * ponytail: camera-on-audio is a known ceiling, not an oversight. The complete
 * fix is for iOS to signal the upgrade so the backend can flip `Call.type` and
 * re-grant via RoomServiceClient.updateParticipant — at which point AUDIO drops
 * to MICROPHONE alone. Needs a client protocol change, so it waits for one.
 */
const AUDIO_SOURCES = [TrackSource.MICROPHONE, TrackSource.CAMERA];
const VIDEO_SOURCES = [
  TrackSource.MICROPHONE,
  TrackSource.CAMERA,
  TrackSource.SCREEN_SHARE,
  TrackSource.SCREEN_SHARE_AUDIO,
];

export class LiveKitService {
  /**
   * Mint a room-scoped JWT for one participant.
   * roomName == callId (1-to-1 today; the same shape generalizes to group later).
   *
   * `callType` is the call row's own `type`. It is optional because it is only
   * ever narrowing: an absent value gets the AUDIO grant, which is the safe end.
   */
  async mintToken(
    roomName: string,
    userId: string,
    callType?: string | null
  ): Promise<LiveKitCredentials> {
    const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
      identity: userId,
      ttl: env.LIVEKIT_TOKEN_TTL,
    });
    // `Call.type` is a free Prisma String with @default("AUDIO"), not an enum,
    // and only the socket schema constrains it — the gRPC handler does
    // `type: req.type ?? "AUDIO"` without validating. So a direct gRPC caller or
    // a pre-migration row can carry lowercase or arbitrary text. Normalize the
    // way call.service.ts already does, and test for VIDEO rather than for
    // AUDIO: anything unrecognized then lands on the NARROWER grant. Written the
    // other way round, one junk value would hand out screenshare.
    const isVideo = String(callType ?? "").toUpperCase() === CallType.VIDEO;
    at.addGrant({
      roomJoin: true,
      room: roomName,
      // Kept alongside `canPublishSources` despite the SDK's "supersedes
      // CanPublish" doc comment: the server ANDs them — the publish gate is
      // checked first and the source list only filters what survives it — so
      // dropping this would deny publishing outright.
      canPublish: true,
      canPublishSources: isVideo ? VIDEO_SOURCES : AUDIO_SOURCES,
      canSubscribe: true,
      // Untouched by the source list: `can_publish_data` is a separate
      // ParticipantPermission field from `can_publish_sources`, so the data
      // channel behaves exactly as before.
      canPublishData: true,
    });
    const token = await at.toJwt();
    return { url: env.LIVEKIT_URL, token };
  }
}
