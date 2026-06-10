-- CreateEnum
CREATE TYPE "GlobalRole" AS ENUM ('USER', 'ADMIN');

-- AlterTable
ALTER TABLE "auth_users" ADD COLUMN     "role" "GlobalRole" NOT NULL DEFAULT 'USER';
