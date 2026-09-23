import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __relayxPrisma: PrismaClient | undefined;
}

export const db: PrismaClient =
  globalThis.__relayxPrisma ??
  new PrismaClient({
    log: ["warn", "error"],
  });

if (!globalThis.__relayxPrisma) globalThis.__relayxPrisma = db;
