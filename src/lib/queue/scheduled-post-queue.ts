import { Queue } from "bullmq";
import { redisConnection } from "./connection";

export const SCHEDULED_POST_QUEUE_NAME = "scheduled-posts";

export interface ScheduledPostJobData {
  scheduledPostId: string;
}

const globalForQueue = globalThis as unknown as {
  scheduledPostQueue: Queue<ScheduledPostJobData> | undefined;
};

export const scheduledPostQueue =
  globalForQueue.scheduledPostQueue ??
  new Queue<ScheduledPostJobData>(SCHEDULED_POST_QUEUE_NAME, { connection: redisConnection });

if (process.env.NODE_ENV !== "production") {
  globalForQueue.scheduledPostQueue = scheduledPostQueue;
}
