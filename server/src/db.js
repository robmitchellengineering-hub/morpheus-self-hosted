// Prisma client singleton. In dev with --watch, avoid exhausting the
// Postgres connection pool across module reloads by caching on `global`.
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.__morpheusPrisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__morpheusPrisma = prisma;
}

export default prisma;
