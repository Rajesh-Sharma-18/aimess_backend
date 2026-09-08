-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "DeviceFormFactor" AS ENUM ('PHONE', 'TABLET', 'DESKTOP');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "NetworkType" AS ENUM ('WIFI', 'CELLULAR', 'ETHERNET', 'VPN', 'OTHER', 'NONE', 'UNKNOWN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "user_devices" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceId" TEXT NOT NULL,
    "platform" "DeviceType" NOT NULL,
    "deviceType" "DeviceFormFactor",
    "deviceName" TEXT,
    "manufacturer" TEXT,
    "brand" TEXT,
    "model" TEXT,
    "osVersion" TEXT,
    "sdkInt" INTEGER,
    "appVersion" TEXT,
    "appBuild" INTEGER,
    "buildType" TEXT,
    "installerPackage" TEXT,
    "locale" TEXT,
    "language" TEXT,
    "country" TEXT,
    "timezone" TEXT,
    "utcOffsetMinutes" INTEGER,
    "screenWidthPx" INTEGER,
    "screenHeightPx" INTEGER,
    "screenDensityDpi" INTEGER,
    "networkType" "NetworkType",
    "carrier" TEXT,
    "isEmulator" BOOLEAN,
    "isRooted" BOOLEAN,
    "ipAddress" TEXT,
    "countryCode" TEXT,
    "userAgent" TEXT,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "user_devices_userId_deviceId_key" ON "user_devices"("userId", "deviceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_devices_userId_lastSeenAt_idx" ON "user_devices"("userId", "lastSeenAt");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
