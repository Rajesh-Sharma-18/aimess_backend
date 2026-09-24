/**
 * A CAMERA `track_published` is the only sign the server gets that a voice call
 * became a video call — clients upgrade client-side and never say so — so the
 * route must forward exactly those to chat-service.
 *
 * The trap is the enum. LiveKit sends `"source": "CAMERA"`, but
 * `WebhookReceiver.receive` parses with protobuf `fromJson`, so the handler sees
 * the NUMERIC `TrackSource`. A string comparison would never match, silently.
 *
 * Requests are signed the way LiveKit signs them — a JWT (key/secret from
 * tests/setup/env.ts) whose `sha256` claim is the base64 SHA-256 of the exact
 * body — so they get past signature verification to the branch under test.
 */
import { createHash } from "node:crypto";

import request from "supertest";
import { AccessToken } from "livekit-server-sdk";

import { createApp } from "../../src/app.js";
import type { MessagingClient } from "../../src/grpc/clients/messaging.client.js";
import type { MediaClient } from "../../src/grpc/clients/media.client.js";

async function postSigned(
  app: ReturnType<typeof createApp>,
  payload: object
) {
  const body = JSON.stringify(payload);
  const at = new AccessToken(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET
  );
  at.sha256 = createHash("sha256").update(body).digest("base64");
  return request(app)
    .post("/livekit/webhook")
    .set("Content-Type", "application/webhook+json")
    .set("Authorization", await at.toJwt())
    .send(body);
}

const trackPublished = (source: "CAMERA" | "MICROPHONE") => ({
  event: "track_published",
  room: { name: "c1" },
  participant: { identity: "u1" },
  track: {
    sid: "TR_1",
    type: source === "CAMERA" ? "VIDEO" : "AUDIO",
    source,
  },
});

describe("LiveKit webhook — camera published", () => {
  it("forwards a CAMERA track_published and ignores the microphone", async () => {
    const handleLiveKitCameraPublished = jest.fn().mockResolvedValue({});
    const app = createApp(
      { handleLiveKitCameraPublished } as unknown as MessagingClient,
      {} as unknown as MediaClient
    );

    const mic = await postSigned(app, trackPublished("MICROPHONE"));
    expect(mic.status).toBe(200);
    expect(handleLiveKitCameraPublished).not.toHaveBeenCalled();

    const camera = await postSigned(app, trackPublished("CAMERA"));
    expect(camera.status).toBe(200);
    expect(handleLiveKitCameraPublished).toHaveBeenCalledWith({
      roomName: "c1",
    });
  });
});
