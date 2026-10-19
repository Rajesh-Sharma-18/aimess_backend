/**
 * AIMESS-369: the private/group reaction `conv:updated` bump carries the typed
 * reaction on both the actor's preview and the target's override, so the
 * gateway can re-render the line per socket language.
 */
jest.mock("../../src/events/publish-conv-updated.js", () => ({
  publishConvUpdatedSafe: jest.fn(),
  publishCommunityUpdatedSafe: jest.fn(),
}));

import { publishConvUpdatedSafe } from "../../src/events/publish-conv-updated.js";
import { ChatMessageOrchestrator } from "../../src/services/chat-message-orchestrator.js";

const pubConv = publishConvUpdatedSafe as jest.Mock;
const ACTOR = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";

it("PRIVATE add: actor and target previews both carry the typed reaction", async () => {
  const privateMessageService = { setReactionActivity: jest.fn().mockResolvedValue(undefined) };
  const userSnapshotService = {
    getUserSnapshotsMap: jest.fn().mockResolvedValue(new Map([[ACTOR, { displayName: "Rajesh" }]])),
  };
  const orchestrator = new ChatMessageOrchestrator(
    privateMessageService as never,
    {} as never,
    {} as never,
    {} as never,
    userSnapshotService as never,
    { getUserSnapshots: jest.fn().mockResolvedValue(new Map()) } as never,
    { publish: jest.fn() } as never,
    {} as never,
    {} as never
  );

  await orchestrator.bumpReactionActivity({
    conversationType: "PRIVATE",
    roomId: "prv_1",
    messageId: "m3",
    emoji: "👍",
    actorId: ACTOR,
    added: true,
    targetUserId: OWNER,
    targetMessagePreview: '"Hi"',
  });

  const reaction = { emoji: "👍", actorId: ACTOR, targetMessageId: "m3" };
  const call = pubConv.mock.calls[0][0];
  expect(call.preview).toMatchObject({ contentType: "SYSTEM", reaction });
  const overrides = await call.resolveOverrides();
  expect(overrides.get(OWNER).preview).toMatchObject({ contentType: "SYSTEM", reaction });
});
