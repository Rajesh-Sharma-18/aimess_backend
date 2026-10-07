import { isAppError } from "@aimess/errors";
import { logger } from "@aimess/logger";

import {
  buildForwardData,
  forwardObjectKeys,
  toCommunityAttachments,
  toDirectContent,
  type ForwardSource,
} from "../lib/forward-source.js";
import type { ConversationKind } from "../lib/chat-message.serializer.js";
import { resolveDisplayName } from "./user-snapshot.service.js";
import type { ChatMessageOrchestrator } from "./chat-message-orchestrator.js";
import type { PrivateMessageService } from "./private-message.service.js";
import type { GroupMessageService } from "./group-message.service.js";
import type { CommunityMessageService } from "./community-message.service.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type {
  ForwardedMediaGrantRepository,
  MediaGrantScope,
} from "../repositories/forwarded-media-grant.repository.js";

export interface ForwardRequest {
  userId: string;
  sources: Array<{ messageId: string; conversationType: ConversationKind }>;
  targets: Array<{
    conversationType: ConversationKind;
    roomId: string;
    clientMessageIds: string[];
  }>;
}

export interface ForwardTargetResult {
  roomId: string;
  conversationType: ConversationKind;
  ok: boolean;
  messages: Array<Record<string, unknown>>;
  error: { code: string } | null;
}

const GRANT_SCOPE: Record<ConversationKind, MediaGrantScope> = {
  PRIVATE: "PRIVATE_CHAT",
  GROUP: "GROUP_CHAT",
  COMMUNITY: "COMMUNITY_CHAT",
};

export class ForwardService {
  constructor(
    private readonly privateMessageService: PrivateMessageService,
    private readonly groupMessageService: GroupMessageService,
    private readonly communityMessageService: CommunityMessageService,
    private readonly orchestrator: ChatMessageOrchestrator,
    private readonly userSnapshotService: UserSnapshotService,
    private readonly cacheRepo: CacheRepository,
    private readonly grantRepo: ForwardedMediaGrantRepository
  ) {}

  async forward(req: ForwardRequest): Promise<ForwardTargetResult[]> {
    // Every source is validated before anything is sent: a bad source fails the whole request.
    const sources: ForwardSource[] = [];
    for (const s of req.sources) {
      sources.push(
        await this.loadSource(s.conversationType, s.messageId, req.userId)
      );
    }
    const names = await this.originalSenderNames(sources);
    const forwardData = sources.map((s) =>
      buildForwardData(s, (id) => names.get(id) ?? "")
    );

    const results: ForwardTargetResult[] = [];
    for (const target of req.targets) {
      const messages: Array<Record<string, unknown>> = [];
      try {
        for (let i = 0; i < sources.length; i++) {
          messages.push(
            await this.sendCopy(
              req.userId,
              target,
              sources[i]!,
              forwardData[i]!,
              target.clientMessageIds[i]!
            )
          );
        }
        results.push({ ...this.head(target), ok: true, messages, error: null });
      } catch (err) {
        if (!isAppError(err)) {
          logger.error(
            `ForwardService|target=${target.roomId} failed: ${String(err)}`
          );
        }
        results.push({
          ...this.head(target),
          ok: false,
          messages,
          error: {
            code: isAppError(err)
              ? (err.messageKey ?? "INTERNAL_ERROR")
              : "INTERNAL_ERROR",
          },
        });
      }
    }
    return results;
  }

  private head(target: ForwardRequest["targets"][number]) {
    return { roomId: target.roomId, conversationType: target.conversationType };
  }

  private loadSource(
    type: ConversationKind,
    messageId: string,
    userId: string
  ): Promise<ForwardSource> {
    if (type === "PRIVATE")
      return this.privateMessageService.loadForwardSource(messageId, userId);
    if (type === "GROUP")
      return this.groupMessageService.loadForwardSource(messageId, userId);
    return this.communityMessageService.loadForwardSource(messageId, userId);
  }

  /** Display names for origins whose row carries none (private rows, legacy forwards). */
  private async originalSenderNames(
    sources: ForwardSource[]
  ): Promise<Map<string, string>> {
    const ids = new Set<string>();
    for (const s of sources) {
      const prev = s.forwardData;
      if (prev?.originalMessageId) {
        if (!prev.originalSenderName && prev.originalSenderId)
          ids.add(String(prev.originalSenderId));
      } else if (!s.senderName && s.senderId) ids.add(s.senderId);
    }
    const out = new Map<string, string>();
    if (ids.size === 0) return out;
    const snaps = await this.userSnapshotService.getUserSnapshotsMap(
      [...ids],
      this.cacheRepo
    );
    for (const id of ids) {
      const name = resolveDisplayName(snaps.get(id));
      out.set(id, name === "Unknown User" ? "" : name);
    }
    return out;
  }

  private async sendCopy(
    userId: string,
    target: ForwardRequest["targets"][number],
    source: ForwardSource,
    forwardData: Record<string, unknown>,
    clientMessageId: string
  ): Promise<Record<string, unknown>> {
    let message: Record<string, unknown>;
    let kind: ConversationKind = target.conversationType;
    if (target.conversationType === "COMMUNITY") {
      // A community's chat room id IS its communityId.
      const result = await this.orchestrator.sendCommunity({
        communityId: target.roomId,
        roomId: target.roomId,
        senderId: userId,
        message: source.content.text,
        messageType: source.contentType,
        clientMessageId,
        attachments: toCommunityAttachments(source.content),
        forwardData,
      });
      message = result.message;
    } else {
      // The PRIVATE peer is derived from the target room's roster inside the send path.
      const result = await this.orchestrator.sendDirect({
        conversationType: target.conversationType,
        roomId: target.roomId,
        senderId: userId,
        content: toDirectContent(source.content),
        messageType: source.contentType,
        clientMessageId,
        forwardData,
      });
      message = result.message;
      // The room-id prefix, not the claim, decides the kind (see resolveConversationType).
      kind = message.conversationType as ConversationKind;
    }
    const keys = forwardObjectKeys(source.content);
    if (keys.length > 0) {
      await this.grantRepo
        .grant(target.roomId, GRANT_SCOPE[kind], keys)
        .catch((err: unknown) => {
          logger.warn(
            `ForwardService|media grant failed room=${target.roomId}: ${String(err)}`
          );
        });
    }
    return message;
  }
}
