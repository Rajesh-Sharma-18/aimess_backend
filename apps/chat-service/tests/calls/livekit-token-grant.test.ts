/**
 * LiveKitService.mintToken — the join grant is scoped to the call's own type.
 *
 * The grant used to be a flat `canPublish: true` with no source list, which
 * means "any track kind": in a VOICE call either side could publish a camera
 * feed or share an entire desktop, and nothing server-side could refuse it. The
 * call's `type` was recorded on the row and drove the UI, but never the token.
 *
 * Nothing is mocked here. The SDK signs locally and tests/setup/env.ts supplies
 * a real key/secret pair, so the honest check is to mint a token and read the
 * claims back out of it — the grant a client actually receives, not the object
 * we believe we passed. `TokenVerifier` also proves the token is genuinely
 * signed, which a hand-rolled base64 decode would not.
 *
 * Note the claim holds LOWERCASE STRINGS, not the numeric TrackSource enum:
 * the SDK maps them through `trackSourceToString` at JWT build time.
 */
import { TokenVerifier } from "livekit-server-sdk";

import { LiveKitService } from "../../src/services/livekit.service.js";

const ROOM = "call-room-1";
const IDENTITY = "user-1";

const AUDIO_SOURCES = ["microphone", "camera"];
const VIDEO_SOURCES = [
  "microphone",
  "camera",
  "screen_share",
  "screen_share_audio",
];

interface VideoGrantClaim {
  room?: string;
  roomJoin?: boolean;
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
  canPublishSources?: string[];
}

const service = new LiveKitService();
const verifier = new TokenVerifier(
  process.env.LIVEKIT_API_KEY as string,
  process.env.LIVEKIT_API_SECRET as string
);

/** Mint for `callType` and hand back the decoded `video` grant claim. */
async function grantFor(callType?: string | null): Promise<VideoGrantClaim> {
  const { token } = await service.mintToken(ROOM, IDENTITY, callType);
  const payload = (await verifier.verify(token)) as {
    video?: VideoGrantClaim;
  };
  return payload.video ?? {};
}

describe("mintToken — publish sources are scoped to the call type", () => {
  it("VIDEO grants camera and screen sharing", async () => {
    const grant = await grantFor("VIDEO");
    expect(grant.canPublishSources).toEqual(VIDEO_SOURCES);
  });

  it("AUDIO grants microphone and camera only", async () => {
    const grant = await grantFor("AUDIO");
    expect(grant.canPublishSources).toEqual(AUDIO_SOURCES);
  });

  it("AUDIO cannot screen share", async () => {
    // The security claim, asserted as itself rather than inferred from the
    // exact-array test above, so it survives a rewrite of that expectation.
    const grant = await grantFor("AUDIO");
    expect(grant.canPublishSources).not.toContain("screen_share");
    expect(grant.canPublishSources).not.toContain("screen_share_audio");
  });

  it("an unrecognized type falls back to the AUDIO grant, never VIDEO", async () => {
    // The one that matters most. `Call.type` is a free Prisma String with no
    // enum behind it, and the gRPC handler does not validate it — only the
    // socket schema does. A direct gRPC caller or a pre-migration row can put
    // anything here, so the fallback has to be the NARROWER grant. Written as
    // `type === "AUDIO" ? audio : video` this test fails, and one junk value
    // would hand out screenshare.
    for (const junk of ["GARBAGE", "", "  ", "VIDEO_CALL", "Video "]) {
      const grant = await grantFor(junk);
      expect(grant.canPublishSources).toEqual(AUDIO_SOURCES);
    }
  });

  it("normalizes case and treats a missing type as AUDIO", async () => {
    expect((await grantFor("video")).canPublishSources).toEqual(VIDEO_SOURCES);
    expect((await grantFor("audio")).canPublishSources).toEqual(AUDIO_SOURCES);
    expect((await grantFor(undefined)).canPublishSources).toEqual(
      AUDIO_SOURCES
    );
    expect((await grantFor(null)).canPublishSources).toEqual(AUDIO_SOURCES);
  });

  it("leaves the rest of the grant intact", async () => {
    // The source list narrows publishing only. `canPublish` must survive it —
    // the server ANDs the two, so dropping it would deny publishing outright —
    // and `canPublishData` is a separate permission field, so the data channel
    // is unaffected. Room scoping and identity are unchanged.
    const grant = await grantFor("AUDIO");
    expect(grant.roomJoin).toBe(true);
    expect(grant.room).toBe(ROOM);
    expect(grant.canPublish).toBe(true);
    expect(grant.canSubscribe).toBe(true);
    expect(grant.canPublishData).toBe(true);
  });
});
