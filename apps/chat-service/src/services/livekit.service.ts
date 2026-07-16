import { AccessToken } from "livekit-server-sdk";
import { env } from "../config/env.js";

export interface LiveKitCredentials {
  url: string;
  token: string;
}

export class LiveKitService {
  /**
   * Mint a room-scoped JWT for one participant.
   * roomName == callId (1-to-1 today; the same shape generalizes to group later).
   */
  async mintToken(
    roomName: string,
    userId: string,
    displayName?: string
  ): Promise<LiveKitCredentials> {
    const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
      identity: userId,
      name: displayName,
      ttl: env.LIVEKIT_TOKEN_TTL,
    });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    const token = await at.toJwt();
    return { url: env.LIVEKIT_URL, token };
  }
}
