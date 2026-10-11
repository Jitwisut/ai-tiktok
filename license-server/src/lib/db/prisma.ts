import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { attachDatabasePool } from "@vercel/functions";
import { PrismaClient } from "@/generated/prisma/client";

const state = globalThis as unknown as { licensePool?: Pool; licensePrisma?: PrismaClient };
if (!state.licensePool) {
  state.licensePool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5, min: 0, idleTimeoutMillis: 5_000, connectionTimeoutMillis: 5_000,
  });
  // Idle connections are released before Vercel suspends a Fluid Compute instance.
  attachDatabasePool(state.licensePool);
  state.licensePool.on("error", () => console.error(JSON.stringify({ event: "license_database_pool_error" })));
}
export const prisma = state.licensePrisma ??= new PrismaClient({ adapter: new PrismaPg(state.licensePool) });
