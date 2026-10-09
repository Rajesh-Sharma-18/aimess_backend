import { CommunityMsgSendSchema } from "../../src/sockets/namespaces/community.ns.js";

describe("community:message:send — video poster", () => {
  it.each(["media", "files"])(
    "keeps %s[].thumbnailObjectKey through validation",
    (field) => {
      const file = {
        objectKey: "chat/u1/video.mp4",
        thumbnailObjectKey: "chat/u1/video-poster.jpg",
        mime: "video/mp4",
      };
      const r = CommunityMsgSendSchema.parse({
        communityId: "c1",
        contentType: "video",
        ...(field === "media" ? { media: { files: [file] } } : { files: [file] }),
      });
      const files = r.media?.files ?? r.files;
      expect(files?.[0]?.thumbnailObjectKey).toBe("chat/u1/video-poster.jpg");
    }
  );
});
