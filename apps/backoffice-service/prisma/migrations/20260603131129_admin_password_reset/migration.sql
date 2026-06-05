-- CreateEnum
CREATE TYPE "AdminOtpPurpose" AS ENUM ('PASSWORD_RESET');

-- CreateTable
CREATE TABLE "AdminOtpCode" (
    "id" UUID NOT NULL,
    "adminId" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "purpose" "AdminOtpPurpose" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "ip" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminOtpCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminPasswordResetToken" (
    "id" UUID NOT NULL,
    "adminId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminPasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminOtpCode_identifier_purpose_consumedAt_idx" ON "AdminOtpCode"("identifier", "purpose", "consumedAt");

-- CreateIndex
CREATE INDEX "AdminOtpCode_adminId_purpose_idx" ON "AdminOtpCode"("adminId", "purpose");

-- CreateIndex
CREATE INDEX "AdminOtpCode_expiresAt_idx" ON "AdminOtpCode"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdminPasswordResetToken_tokenHash_key" ON "AdminPasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AdminPasswordResetToken_adminId_idx" ON "AdminPasswordResetToken"("adminId");

-- CreateIndex
CREATE INDEX "AdminPasswordResetToken_expiresAt_idx" ON "AdminPasswordResetToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "AdminOtpCode" ADD CONSTRAINT "AdminOtpCode_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminPasswordResetToken" ADD CONSTRAINT "AdminPasswordResetToken_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
