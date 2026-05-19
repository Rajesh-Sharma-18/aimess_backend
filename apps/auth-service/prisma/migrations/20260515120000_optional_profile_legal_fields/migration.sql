-- Allow minimal registration (email, account, password only).
ALTER TABLE "auth_users" ALTER COLUMN "dateOfBirth" DROP NOT NULL;
ALTER TABLE "auth_users" ALTER COLUMN "termsAcceptedAt" DROP NOT NULL;
ALTER TABLE "auth_users" ALTER COLUMN "privacyAcceptedAt" DROP NOT NULL;
ALTER TABLE "auth_users" ALTER COLUMN "termsVersion" DROP NOT NULL;
ALTER TABLE "auth_users" ALTER COLUMN "privacyVersion" DROP NOT NULL;
