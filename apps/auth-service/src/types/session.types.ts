import type { DeviceType } from "../generated/prisma/client.js";

export type ActiveSessionItem = {
  sessionId: string;
  deviceId: string;
  deviceName: string | null;
  deviceType: DeviceType;
  osVersion: string | null;
  appVersion: string | null;
  ipAddress: string | null;
  countryCode: string | null;
  lastActiveAt: string;
  createdAt: string;
  isCurrent: boolean;
};

export type ListSessionsResult = {
  sessions: ActiveSessionItem[];
};

export type RevokeSessionsResult = {
  revokedCount: number;
};
