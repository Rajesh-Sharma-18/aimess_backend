CREATE TYPE "CustomCredentialPlatform" AS ENUM ('ANDROID', 'IOS', 'WEB');

DROP INDEX "CustomCredential_provider_key";

ALTER TABLE "CustomCredential"
    DROP COLUMN "provider",
    DROP COLUMN "type",
    DROP COLUMN "enabled",
    ADD COLUMN "name" TEXT NOT NULL,
    ADD COLUMN "platform" "CustomCredentialPlatform" NOT NULL;

CREATE UNIQUE INDEX "CustomCredential_name_platform_key" ON "CustomCredential"("name", "platform");
