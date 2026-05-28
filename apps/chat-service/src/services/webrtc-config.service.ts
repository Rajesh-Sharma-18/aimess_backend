import { logger } from "@aimess/logger";
import { env } from "../config/env.js";

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
  credentialType?: "password" | "oauth";
}

export interface RtcConfiguration {
  iceServers: IceServer[];
  iceCandidatePoolSize: number;
  iceTransportPolicy: "all" | "relay";
}

export class WebRtcConfigService {
  buildIceServers(): IceServer[] {
    const iceServers: IceServer[] = [];

    if (env.WEBRTC_STUN_SERVERS) {
      const stunUrls = env.WEBRTC_STUN_SERVERS.split(",")
        .map((u) => u.trim())
        .filter(Boolean);
      if (stunUrls.length > 0) {
        iceServers.push({ urls: stunUrls });
      }
    }

    if (env.WEBRTC_TURN_SERVER) {
      const turnUrl = env.WEBRTC_TURN_SERVER.trim();
      if (turnUrl && env.WEBRTC_TURN_USERNAME && env.WEBRTC_TURN_PASSWORD) {
        iceServers.push({
          urls: [turnUrl],
          username: env.WEBRTC_TURN_USERNAME,
          credential: env.WEBRTC_TURN_PASSWORD,
          credentialType: "password",
        });
      } else if (turnUrl) {
        logger.warn(
          "WebRtcConfigService: TURN server configured but missing credentials"
        );
      }
    }

    if (iceServers.length === 0) {
      logger.warn(
        "WebRtcConfigService: No ICE servers configured (STUN/TURN disabled)"
      );
    }

    return iceServers;
  }

  getRtcConfiguration(): RtcConfiguration {
    return {
      iceServers: this.buildIceServers(),
      iceCandidatePoolSize: env.WEBRTC_ICE_CANDIDATE_POOL_SIZE,
      iceTransportPolicy: "all",
    };
  }

  getCodecPreferences(): { audio: string[]; video: string[] } {
    const [audioStr, videoStr] = env.WEBRTC_RTC_CODEC_PREFERENCES.split(";");
    return {
      audio: (audioStr ?? "opus").split(",").map((c) => c.trim()),
      video: (videoStr ?? "h264").split(",").map((c) => c.trim()),
    };
  }
}
