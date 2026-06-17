/** Socket-level DTOs for community real-time events (community-service → gateway → clients). */

export interface CommunitySummaryDto {
  communityId: string;
  name: string;
  avatar: string | null;
  memberCount: number;
  updatedAt: number; // epoch ms
}

export interface CommunityStatsUpdatedPayload {
  communityId: string;
  memberCount: number;
  updatedAt: number; // epoch ms
}

export interface CommunityMemberRemovedPayload {
  communityId: string;
  userId: string; // who was removed
  reason: "kicked" | "banned" | "left";
  actorId?: string; // who performed the action; same as userId for voluntary leave
  updatedAt: number; // epoch ms
}

export interface CommunityMemberUnbannedPayload {
  communityId: string;
  userId: string; // who was unbanned
  actorId: string;
  updatedAt: number; // epoch ms
}
