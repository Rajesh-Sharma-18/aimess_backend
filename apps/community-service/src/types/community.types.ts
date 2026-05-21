import type {
  CommunityMemberRole,
  CommunityType,
} from "../generated/prisma/index.js";

export type CommunityImageView = {
  url: string;
  expiresIn: number;
};

/** Full community payload returned by create / get / patch. */
export type CommunityData = {
  id: string;
  name: string;
  handle: string;
  description: string | null;
  type: CommunityType;
  category: {
    id: string;
    name: string;
  };
  creatorId: string;
  adminId: string;
  memberCount: number;
  /** Presigned GET URL (private bucket); null if no avatar. */
  avatarUrl: string | null;
  avatarUrlExpiresIn: number | null;
  /** Presigned GET URL (private bucket); null if no cover. */
  coverUrl: string | null;
  coverUrlExpiresIn: number | null;
  /** Caller's membership role, or null if not a member. */
  myRole: CommunityMemberRole | null;
  createdAt: string;
  updatedAt: string;
};

export type CommunityAvailability = {
  name?: string;
  handle?: string;
  available: boolean;
};

export type CommunityCategoryData = {
  id: string;
  name: string;
  slug: string;
};

export type CommunityListItem = {
  id: string;
  name: string;
  handle: string;
  type: CommunityType;
  memberCount: number;
  avatarUrl: string | null;
  avatarUrlExpiresIn: number | null;
  myRole: CommunityMemberRole;
};

export type MyCommunitiesResult = {
  communities: CommunityListItem[];
  nextCursor: string | null;
};
