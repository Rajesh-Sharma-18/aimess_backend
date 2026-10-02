import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from "@aimess/errors";
import { logger } from "@aimess/logger";

import { env } from "../config/env.js";
import { AUDIT_ACTIONS } from "../constants/index.js";
import type { CustomCredential } from "../generated/prisma/client.js";
import { verifyPassword } from "../lib/password.js";
import { openSecret, sealSecret } from "../lib/secret-box.js";
import { adminUserRepository } from "../repositories/admin-user.repository.js";
import { customCredentialRepository } from "../repositories/custom-credential.repository.js";
import {
  CUSTOM_CREDENTIAL_PLATFORMS,
  type CreateCustomCredentialInput,
  type CustomCredentialPlatform,
  type CustomCredentialView,
  type ResolvedCustomCredential,
  type UpdateCustomCredentialInput,
} from "../types/custom-credential.types.js";
import { auditService } from "./audit.service.js";

type RequestCtx = { ip: string; userAgent: string | null };

const NOT_CONFIGURED: ResolvedCustomCredential = { configured: false, value: "" };

function toView(row: CustomCredential): CustomCredentialView {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    maskedValue: `••••${row.lastFour}`,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function seal(value: string): { encryptedValue: string; lastFour: string } {
  const key = env.CUSTOM_CREDENTIALS_ENCRYPTION_KEY;
  if (!key) {
    throw new ServiceUnavailableError("CUSTOM_CREDENTIAL_ENCRYPTION_UNAVAILABLE");
  }
  return { encryptedValue: sealSecret(value, key), lastFour: value.slice(-4) };
}

async function assertSlotFree(
  name: string,
  platform: CustomCredentialPlatform,
  exceptId?: string
): Promise<void> {
  const taken = await customCredentialRepository.findByNameAndPlatform(name, platform);
  if (taken && taken.id !== exceptId) {
    throw new ConflictError("CUSTOM_CREDENTIAL_EXISTS");
  }
}

async function assertActorPassword(actorId: string, password: string): Promise<void> {
  const admin = await adminUserRepository.findById(actorId);
  if (!admin || !(await verifyPassword(password, admin.passwordHash))) {
    throw new BadRequestError("AUTH_CURRENT_PASSWORD_INVALID");
  }
}

function isPlatform(platform: string): platform is CustomCredentialPlatform {
  return (CUSTOM_CREDENTIAL_PLATFORMS as readonly string[]).includes(platform);
}

export const customCredentialService = {
  async list(): Promise<CustomCredentialView[]> {
    const rows = await customCredentialRepository.list();
    return rows.map(toView);
  },

  async create(
    input: CreateCustomCredentialInput,
    actorId: string,
    ctx: RequestCtx
  ): Promise<CustomCredentialView> {
    const sealed = seal(input.value);
    await assertSlotFree(input.name, input.platform);

    const row = await customCredentialRepository.create({
      name: input.name,
      platform: input.platform,
      ...sealed,
      actorId,
    });

    await auditService.record({
      actorId,
      action: AUDIT_ACTIONS.CUSTOM_CREDENTIAL_CREATED,
      targetType: "custom_credential",
      targetId: row.id,
      after: { name: row.name, platform: row.platform },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return toView(row);
  },

  async update(
    id: string,
    input: UpdateCustomCredentialInput,
    password: string,
    actorId: string,
    ctx: RequestCtx
  ): Promise<CustomCredentialView> {
    await assertActorPassword(actorId, password);

    const existing = await customCredentialRepository.findById(id);
    if (!existing) throw new NotFoundError("CUSTOM_CREDENTIAL_NOT_FOUND");

    const sealed = input.value !== undefined ? seal(input.value) : {};
    const name = input.name ?? existing.name;
    const platform = input.platform ?? existing.platform;
    if (name !== existing.name || platform !== existing.platform) {
      await assertSlotFree(name, platform, id);
    }

    const row = await customCredentialRepository.update(id, {
      name: input.name,
      platform: input.platform,
      ...sealed,
      actorId,
    });

    await auditService.record({
      actorId,
      action: AUDIT_ACTIONS.CUSTOM_CREDENTIAL_UPDATED,
      targetType: "custom_credential",
      targetId: row.id,
      before: { name: existing.name, platform: existing.platform },
      after: {
        name: row.name,
        platform: row.platform,
        valueChanged: input.value !== undefined,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return toView(row);
  },

  async remove(
    id: string,
    password: string,
    actorId: string,
    ctx: RequestCtx
  ): Promise<void> {
    await assertActorPassword(actorId, password);

    const existing = await customCredentialRepository.findById(id);
    if (!existing) throw new NotFoundError("CUSTOM_CREDENTIAL_NOT_FOUND");

    await customCredentialRepository.delete(id);

    await auditService.record({
      actorId,
      action: AUDIT_ACTIONS.CUSTOM_CREDENTIAL_DELETED,
      targetType: "custom_credential",
      targetId: id,
      before: { name: existing.name, platform: existing.platform },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  },

  async listForPlatform(platform: string): Promise<{ name: string; value: string }[]> {
    const key = env.CUSTOM_CREDENTIALS_ENCRYPTION_KEY;
    if (!key || !isPlatform(platform) || platform === "ALL") return [];

    const rows = await customCredentialRepository.listForPlatforms(["ALL", platform]);
    const byName = new Map<string, string>();
    const ordered = [
      ...rows.filter((row) => row.platform === "ALL"),
      ...rows.filter((row) => row.platform !== "ALL"),
    ];
    for (const row of ordered) {
      try {
        byName.set(row.name, openSecret(row.encryptedValue, key));
      } catch {
        logger.error(`customCredential|failed to decrypt ${row.name} for ${row.platform}`);
      }
    }
    return [...byName].map(([name, value]) => ({ name, value }));
  },

  async resolve(name: string, platform: string): Promise<ResolvedCustomCredential> {
    const key = env.CUSTOM_CREDENTIALS_ENCRYPTION_KEY;
    if (!key || !name || !isPlatform(platform)) return NOT_CONFIGURED;

    const row =
      (await customCredentialRepository.findByNameAndPlatform(name, platform)) ??
      (await customCredentialRepository.findByNameAndPlatform(name, "ALL"));
    if (!row) return NOT_CONFIGURED;

    try {
      return { configured: true, value: openSecret(row.encryptedValue, key) };
    } catch {
      logger.error(`customCredential|failed to decrypt ${name} for ${platform}`);
      return NOT_CONFIGURED;
    }
  },
};
