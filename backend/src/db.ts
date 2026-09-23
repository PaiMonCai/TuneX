import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __tunexPrisma: PrismaClient | undefined;
}

export const db: PrismaClient =
  globalThis.__tunexPrisma ??
  new PrismaClient({
    log: ["warn", "error"],
  });

if (!globalThis.__tunexPrisma) globalThis.__tunexPrisma = db;
