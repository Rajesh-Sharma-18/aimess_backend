export const WEBRTC_CODECS = {
  AUDIO: ["opus", "g722", "pcmu", "pcma"],
  VIDEO: ["h264", "vp8", "vp9"],
} as const;

export const WEBRTC_CALL_CONSTRAINTS = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  video: {
    width: { ideal: 1280 },
    height: { ideal: 720 },
  },
} as const;

export const WEBRTC_TIMEOUTS = {
  CALL_RING_TIMEOUT_SEC: 120,
  CALL_ANSWER_WAIT_TIMEOUT_SEC: 45,
  ICE_GATHER_TIMEOUT_MS: 5000,
} as const;

export const WEBRTC_ICE_TRANSPORT_POLICY = "all" as const;

export const WEBRTC_RTC_CONFIG = {
  iceServers: [] as {
    urls: string[];
    username?: string;
    credential?: string;
    credentialType?: string;
  }[],
  iceTransportPolicy: WEBRTC_ICE_TRANSPORT_POLICY,
  iceCandidatePoolSize: 10,
} as const;
