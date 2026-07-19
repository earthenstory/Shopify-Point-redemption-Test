import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient();
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient();

// Warm the connection pool at boot so the first storefront/cart request after a
// Cloud Run cold start doesn't also pay the Prisma connect latency. Fire-and-forget:
// queries will connect lazily anyway if this hasn't resolved yet.
void prisma.$connect().catch(() => {});

export default prisma;
