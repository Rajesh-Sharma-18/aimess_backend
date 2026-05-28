/*
  Warnings:

  - A unique constraint covering the columns `[account]` on the table `user_profiles` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "user_profiles" ADD COLUMN     "account" VARCHAR(32);

-- CreateIndex
CREATE UNIQUE INDEX "user_profiles_account_key" ON "user_profiles"("account");
