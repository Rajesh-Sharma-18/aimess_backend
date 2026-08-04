-- Adds EVERYONE to CallPrivacyScope so "Who can call me → Everyone" (Figma) can
-- be stored. Additive only: the column default stays FRIENDS, so no existing
-- row changes meaning and nobody starts accepting calls from non-friends
-- without explicitly choosing it.
ALTER TYPE "CallPrivacyScope" ADD VALUE IF NOT EXISTS 'EVERYONE' BEFORE 'FRIENDS';
