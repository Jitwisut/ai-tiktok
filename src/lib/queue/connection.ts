import IORedis from "ioredis";

const globalForRedis = globalThis as unknown as {
  redisConnection: IORedis | undefined;
};

export const redisConnection =
  globalForRedis.redisConnection ??
  new IORedis(process.env.REDIS_URL ?? "redis://localhost:6380", {
    maxRetriesPerRequest: null,
  });

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redisConnection = redisConnection;
}
