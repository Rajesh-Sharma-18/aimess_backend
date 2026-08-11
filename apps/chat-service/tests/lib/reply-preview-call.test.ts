/**
 * `buildReplyPreviewText` for call rows (VOICE_CALL / VIDEO_CALL).
 *
 * A call row's own `content.text` is its lifecycle sentence ("Voice call
 * cancelled") and it is rewritten in place on every transition. A reply quote
 * names the thing replied to, so it must be status-independent — otherwise the
 * quote silently changes wording under the reply when the call settles.
 */
import { buildReplyPreviewText } from "../../src/lib/chat-message.serializer.js";

const callContent = (text: string, callType: string) => ({
  text,
  urls: [],
  files: [],
  call: { callType, callStatus: "CANCELLED", outcome: "CANCELLED" },
});

describe("buildReplyPreviewText — call rows", () => {
  it("labels a voice call independent of its lifecycle text", () => {
    expect(
      buildReplyPreviewText(
        "VOICE_CALL",
        callContent("Voice call cancelled", "AUDIO"),
        0
      )
    ).toBe("📞 Voice call");
    expect(
      buildReplyPreviewText(
        "VOICE_CALL",
        callContent("Voice call ringing", "AUDIO"),
        0
      )
    ).toBe("📞 Voice call");
  });

  it("labels a video call", () => {
    expect(
      buildReplyPreviewText(
        "video_call",
        callContent("Video call cancelled", "VIDEO"),
        0
      )
    ).toBe("📹 Video call");
  });

  it("leaves text rows untouched", () => {
    expect(buildReplyPreviewText("TEXT", { text: "hello" }, 0)).toBe("hello");
  });
});
