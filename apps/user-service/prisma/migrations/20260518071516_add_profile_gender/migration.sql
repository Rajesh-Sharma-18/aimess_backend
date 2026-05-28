-- CreateEnum
CREATE TYPE "ProfileGender" AS ENUM ('MALE', 'FEMALE', 'NON_BINARY', 'PREFER_NOT_TO_SAY', 'OTHER');

-- AlterTable
ALTER TABLE "user_profiles" ADD COLUMN     "gender" "ProfileGender";
