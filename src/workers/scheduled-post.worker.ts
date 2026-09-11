import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { createWorkerConnection } from "@/lib/queue/connection";
import {
  SCHEDULED_POST_QUEUE_NAME,
  type ScheduledPostJobData,
} from "@/lib/queue/scheduled-post-queue";
import { prisma } from "@/lib/db/prisma";
import { getPublisher } from "@/lib/publishers";

async function processScheduledPost(job: Job<ScheduledPostJobData>) {
  const { scheduledPostId } = job.data;

  const post = await prisma.scheduledPost.findUnique({
    where: { id: scheduledPostId },
    include: { video: { include: { content: true } } },
  });

  // Cancelled (or already handled) — the delayed job still fires, but this
  // is a no-op rather than a publish. Cheaper and more robust than trying
  // to remove the BullMQ job on cancel.
  if (!post || post.status !== "scheduled") return;

  if (!post.video.videoUrl) {
    await prisma.scheduledPost.update({
      where: { id: post.id },
      data: { status: "failed", error: "วิดีโอนี้ไม่มีไฟล์จริง (mock provider) จึงโพสต์ไม่ได้" },
    });
    return;
  }

  try {
    const publisher = getPublisher(post.platform);
    const result = await publisher.publish({
      videoUrl: post.video.videoUrl,
      caption: `${post.video.content.caption}\n\n${post.video.content.cta}`,
    });

    await prisma.scheduledPost.update({
      where: { id: post.id },
      data: { status: "posted", platformPostId: result.platformPostId, error: null },
    });
  } catch (err) {
    await prisma.scheduledPost.update({
      where: { id: post.id },
      data: {
        status: "failed",
        error: err instanceof Error ? err.message : "โพสต์ไม่สำเร็จ",
      },
    });
  }
}

const worker = new Worker<ScheduledPostJobData>(
  SCHEDULED_POST_QUEUE_NAME,
  processScheduledPost,
  { connection: createWorkerConnection() },
);

worker.on("ready", () => console.log("[scheduled-post.worker] ready"));

console.log("[scheduled-post.worker] started, waiting for jobs...");
