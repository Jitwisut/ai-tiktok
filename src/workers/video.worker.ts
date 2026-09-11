import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { createWorkerConnection } from "@/lib/queue/connection";
import { VIDEO_QUEUE_NAME, type VideoJobData } from "@/lib/queue/video-queue";
import { prisma } from "@/lib/db/prisma";
import { getVideoProvider } from "@/lib/video";
import { VIDEO_CREDIT_COST } from "@/services/video.service";

const BACKOFF_DELAYS_MS = [60_000, 180_000, 600_000];

async function processVideoJob(job: Job<VideoJobData>) {
  const { videoId } = job.data;

  await prisma.video.update({
    where: { id: videoId },
    data: { status: "processing", attempts: job.attemptsMade + 1 },
  });

  const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
  const settings = video.settings as { promptText: string };

  const provider = getVideoProvider();
  const result = await provider.generate({
    prompt: settings.promptText,
    aspectRatio: video.aspectRatio ?? "9:16",
    duration: video.duration ?? 8,
  });

  await prisma.video.update({
    where: { id: videoId },
    data: {
      status: "completed",
      videoUrl: result.videoUrl,
      thumbnailUrl: result.thumbnailUrl,
      duration: result.duration,
      errorMessage: null,
    },
  });
}

const worker = new Worker<VideoJobData>(VIDEO_QUEUE_NAME, processVideoJob, {
  connection: createWorkerConnection(),
  settings: {
    backoffStrategy: (attemptsMade) =>
      BACKOFF_DELAYS_MS[attemptsMade - 1] ?? BACKOFF_DELAYS_MS.at(-1)!,
  },
});

worker.on("failed", async (job, err) => {
  if (!job) return;

  const attemptsAllowed = job.opts.attempts ?? 1;
  const isFinalAttempt = job.attemptsMade >= attemptsAllowed;

  if (!isFinalAttempt) {
    await prisma.video
      .update({
        where: { id: job.data.videoId },
        data: { errorMessage: err.message },
      })
      .catch(() => {});
    return;
  }

  const video = await prisma.video.findUnique({ where: { id: job.data.videoId } });
  if (!video || video.status === "failed") return;

  await prisma.$transaction([
    prisma.video.update({
      where: { id: video.id },
      data: { status: "failed", errorMessage: err.message },
    }),
    prisma.user.update({
      where: { id: video.userId },
      data: { credits: { increment: VIDEO_CREDIT_COST } },
    }),
    prisma.creditTransaction.create({
      data: {
        userId: video.userId,
        type: "refund",
        amount: VIDEO_CREDIT_COST,
        referenceId: video.id,
        description: `Refund for failed video generation (${video.id})`,
      },
    }),
  ]);
});

worker.on("ready", () => console.log("[video.worker] ready"));

console.log("[video.worker] started, waiting for jobs...");
