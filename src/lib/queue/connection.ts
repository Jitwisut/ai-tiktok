import IORedis from "ioredis";

const globalForRedis = globalThis as unknown as {
  redisConnection: IORedis | undefined;
};

/** Shared connection for non-blocking use (Queue.add, one-off commands). */
export const redisConnection =
  globalForRedis.redisConnection ??
  new IORedis(process.env.REDIS_URL ?? "redis://localhost:6380", {
    maxRetriesPerRequest: null,
  });

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redisConnection = redisConnection;
}

/**
 * A BullMQ Worker/QueueEvents issues blocking commands (BZPOPMIN) on its
 * connection, which starves any other consumer sharing that connection in
 * the same process. Each Worker/QueueEvents must get its own — never reuse
 * `redisConnection` for one.
 */
export function createWorkerConnection() {
  return new IORedis(process.env.REDIS_URL ?? "redis://localhost:6380", {
    maxRetriesPerRequest: null,
  });
}
