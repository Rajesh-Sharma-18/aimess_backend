import { prisma } from "../config/prisma.js";
import {
  OtpChannel,
  OtpPurpose,
  type OtpCode,
} from "../generated/prisma/client.js";

export const otpRepository = {
  consumeActiveForIdentifier(identifier: string, purpose: OtpPurpose) {
    return prisma.otpCode.updateMany({
      where: {
        identifier,
        purpose,
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });
  },

  create(params: {
    userId: string | null;
    identifier: string;
    purpose: OtpPurpose;
    codeHash: string;
    expiresAt: Date;
    ipAddress?: string | null;
    maxAttempts: number;
  }): Promise<OtpCode> {
    return prisma.otpCode.create({
      data: {
        userId: params.userId,
        identifier: params.identifier,
        channel: OtpChannel.EMAIL,
        purpose: params.purpose,
        codeHash: params.codeHash,
        maxAttempts: params.maxAttempts,
        expiresAt: params.expiresAt,
        ipAddress: params.ipAddress ?? undefined,
      },
    });
  },

  findLatestActive(identifier: string, purpose: OtpPurpose) {
    return prisma.otpCode.findFirst({
      where: {
        identifier,
        purpose,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });
  },

  incrementAttempts(id: string) {
    return prisma.otpCode.update({
      where: { id },
      data: { attempts: { increment: 1 } },
    });
  },

  markConsumed(id: string) {
    return prisma.otpCode.update({
      where: { id },
      data: { consumedAt: new Date() },
    });
  },
};
