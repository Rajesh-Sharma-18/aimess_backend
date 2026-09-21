-- A permanent Super Admin ban and a time-boxed suspension both used to mirror
-- onto this profile as SUSPENDED, so user-service could not tell them apart and
-- people search had no way to exclude only the banned ones.
--
-- BEFORE 'DELETED' keeps the type's value order identical to the enum in
-- schema.prisma. No backfill: every existing row keeps the status it has, and
-- backoffice writes BANNED from the next ban onward.
ALTER TYPE "ProfileStatus" ADD VALUE IF NOT EXISTS 'BANNED' BEFORE 'DELETED';
