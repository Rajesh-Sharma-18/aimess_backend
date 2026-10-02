import { prisma } from "../config/prisma.js";
import type { CustomCredential } from "../generated/prisma/client.js";
import type { CustomCredentialPlatform } from "../types/custom-credential.types.js";

export const customCredentialRepository = {
  list(): Promise<CustomCredential[]> {
    return prisma.customCredential.findMany({
      orderBy: [{ name: "asc" }, { platform: "asc" }],
    });
  },

  listForPlatforms(platforms: CustomCredentialPlatform[]): Promise<CustomCredential[]> {
    return prisma.customCredential.findMany({ where: { platform: { in: platforms } } });
  },

  findById(id: string): Promise<CustomCredential | null> {
    return prisma.customCredential.findUnique({ where: { id } });
  },

  findByNameAndPlatform(
    name: string,
    platform: CustomCredentialPlatform
  ): Promise<CustomCredential | null> {
    return prisma.customCredential.findUnique({
      where: { name_platform: { name, platform } },
    });
  },

  create(data: {
    name: string;
    platform: CustomCredentialPlatform;
    encryptedValue: string;
    lastFour: string;
    actorId: string;
  }): Promise<CustomCredential> {
    return prisma.customCredential.create({
      data: {
        name: data.name,
        platform: data.platform,
        encryptedValue: data.encryptedValue,
        lastFour: data.lastFour,
        createdById: data.actorId,
        updatedById: data.actorId,
      },
    });
  },

  update(
    id: string,
    data: {
      name?: string;
      platform?: CustomCredentialPlatform;
      encryptedValue?: string;
      lastFour?: string;
      actorId: string;
    }
  ): Promise<CustomCredential> {
    return prisma.customCredential.update({
      where: { id },
      data: {
        name: data.name,
        platform: data.platform,
        encryptedValue: data.encryptedValue,
        lastFour: data.lastFour,
        updatedById: data.actorId,
      },
    });
  },

  async delete(id: string): Promise<void> {
    await prisma.customCredential.delete({ where: { id } });
  },
};
