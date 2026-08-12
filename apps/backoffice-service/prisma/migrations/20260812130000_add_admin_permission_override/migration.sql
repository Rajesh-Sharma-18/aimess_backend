-- CreateTable
-- Per-admin DELTA on top of the role baseline (allow = grant, deny = revoke).
-- The composite PK makes a contradictory allow+deny pair for the same
-- (admin, permission) unrepresentable.
CREATE TABLE "AdminPermissionOverride" (
    "adminId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,
    "allow" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AdminPermissionOverride_pkey" PRIMARY KEY ("adminId","permissionId")
);

-- CreateIndex
CREATE INDEX "AdminPermissionOverride_adminId_idx" ON "AdminPermissionOverride"("adminId");

-- AddForeignKey
ALTER TABLE "AdminPermissionOverride" ADD CONSTRAINT "AdminPermissionOverride_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminPermissionOverride" ADD CONSTRAINT "AdminPermissionOverride_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
