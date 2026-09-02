-- Durable admin login lockout (AIM-30).
--
-- The failure counter lived only in Redis, so a cache flush cleared every
-- lockout on the highest-privilege login on the platform.
CREATE TABLE "AdminLoginFailure" (
    "email" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "windowStartedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AdminLoginFailure_pkey" PRIMARY KEY ("email")
);

-- Supports the sweep that clears rows whose window has long closed.
CREATE INDEX "AdminLoginFailure_updatedAt_idx" ON "AdminLoginFailure"("updatedAt");
