import {
  AccessToken,
  RoomServiceClient,
  ServerError,
  TrackSource,
} from "livekit-server-sdk";
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
 * CAMERA stays allowed on an AUDIO call, deliberately. Clients upgrade voice to
 * video entirely client-side (e.g. iOS `LiveKitCallSignalingService.upgradeToVideo`)
 * and never tell the backend. `Call.type` flips to "VIDEO" only when LiveKit's
 * `track_published` webhook reports the camera (CallService.markVideo) — i.e.
 * AFTER the camera is already live — so denying camera here would break every
 * mid-call upgrade. SCREEN_SHARE is denied there because no client implements
 * screen sharing at all, so the restriction costs nothing today and closes the
 * larger hole. A token minted AFTER that flip (re-answer, reconnect, a group
 * late joiner) gets the VIDEO list, screen share included — equally harmless
 * while no client shares a screen.
 *
 * Listing sources explicitly also denies anything LiveKit adds to the enum
 * later, which is the direction this should fail.
 *
 * ponytail: camera-on-audio is a known ceiling, not an oversight. Dropping AUDIO
 * to MICROPHONE alone needs clients to ASK before publishing a camera (then
 * re-grant via RoomServiceClient.updateParticipant) — the webhook only reports
 * after the fact. Needs a client protocol change, so it waits for one.
 */
const AUDIO_SOURCES = [TrackSource.MICROPHONE, TrackSource.CAMERA];
const VIDEO_SOURCES = [
  TrackSource.MICROPHONE,
  TrackSource.CAMERA,
  TrackSource.SCREEN_SHARE,
  TrackSource.SCREEN_SHARE_AUDIO,
];

export class LiveKitService {
  private rooms: RoomServiceClient | null = null;

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

  /**
   * Disconnect every participant still in a finished call's room. A leg's token
   * outlives the call (LIVEKIT_TOKEN_TTL), so a client that never hears
   * `call:ended` — signed out, session revoked, socket gone — otherwise keeps
   * streaming media into the room.
   */
  async deleteRoom(roomName: string): Promise<void> {
    await this.roomClient().deleteRoom(roomName);
  }

  /**
   * How many participants LiveKit has in `roomName` right now, read live from
   * the Room API.
   *
   * Never use a webhook's `room.numParticipants` for this: LiveKit fills it from
   * a cache it refreshes in the background, so a `participant_left` can still
   * count the participant who just left — and, during a duplicate-identity
   * eviction, it can undercount a room that is still full.
   *
   * A participant LiveKit is still waiting on to reconnect stays listed, so a
   * network blip counts as present. A room LiveKit no longer knows holds nobody
   * — open-source LiveKit answers that with an empty list, and a Twirp
   * `not_found` is read the same way. Anything else throws, a bare HTTP 404
   * included: that is also what a proxy that does not route `/twirp` answers,
   * and reading it as "empty" would report every room empty at once.
   */
  async countParticipants(roomName: string): Promise<number> {
    try {
      return (await this.roomClient().listParticipants(roomName)).length;
    } catch (err) {
      if (err instanceof ServerError && err.code === "not_found") return 0;
      throw err;
    }
  }

  private roomClient(): RoomServiceClient {
    this.rooms ??= new RoomServiceClient(
      env.LIVEKIT_URL.replace(/^ws/, "http"),
      env.LIVEKIT_API_KEY,
      env.LIVEKIT_API_SECRET
    );
    return this.rooms;
  }
}
