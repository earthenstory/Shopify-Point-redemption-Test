-- Newer @shopify/shopify-app-session-storage-prisma persists rotating refresh
-- tokens on the session.
ALTER TABLE "Session" ADD COLUMN "refreshToken" TEXT;
ALTER TABLE "Session" ADD COLUMN "refreshTokenExpires" TIMESTAMP(3);
