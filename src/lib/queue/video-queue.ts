import { Queue } from "bullmq";
import { redisConnection } from "./connection";

export const VIDEO_QUEUE_NAME = "video-generation";

export interface VideoJobData {
  videoId: string;
}

const globalForQueue = globalThis as unknown as {
  videoQueue: Queue<VideoJobData> | undefined;
};

export const videoQueue =
  globalForQueue.videoQueue ??
  new Queue<VideoJobData>(VIDEO_QUEUE_NAME, { connection: redisConnection });

if (process.env.NODE_ENV !== "production") {
  globalForQueue.videoQueue = videoQueue;
}
