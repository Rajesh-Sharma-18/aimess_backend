/**
 * List-screen preview string for a community room's last message. Pure mapper
 * over the room's denormalized `lastMessage` JSON (no DB re-query): text shows
 * the content, media types show a labelled placeholder. `messageType` is
 * normalized to lower-case so both community ("image") and any upper-case
 * variants resolve consistently.
 */
export function communityMessagePreview(params: {
  messageType: string | null | undefined;
  content: string | null | undefined;
}): string {
  const type = (params.messageType || "").toLowerCase();
  const content = (params.content || "").trim();

  switch (type) {
    case "text":
      return content || "Sent a message";
    case "image":
    case "photo":
      return "📷 Photo";
    case "video":
      return "🎥 Video";
    case "file":
    case "document":
    case "custom":
      return "📎 File";
    case "audio":
    case "voice":
      return "🎙️ Voice message";
    case "gif":
      return "GIF";
    case "sticker":
      return "Sticker";
    case "location":
      return "📍 Location";
    default:
      return content || "Sent a message";
  }
}
