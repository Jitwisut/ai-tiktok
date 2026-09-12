import { prisma } from "@/lib/db/prisma";
import { scheduledPostQueue } from "@/lib/queue/scheduled-post-queue";
import type { CreateScheduledPostInput } from "@/lib/validation/scheduled-post";

export async function createSchedule(userId: string, input: CreateScheduledPostInput) {
  const video = await prisma.video.findFirst({
    where: { id: input.videoId, userId, status: "completed" },
  });
  if (!video) return { error: "video_not_ready" as const };

  const scheduledPost = await prisma.scheduledPost.create({
    data: {
      userId,
      videoId: input.videoId,
      platform: input.platform,
      method: input.method,
      scheduledAt: input.scheduledAt,
    },
  });

  // Extension posts are collected by the extension when they come due, so
  // they must not also be handed to the worker — it would publish them
  // through the Publisher adapter as well.
  if (input.method === "api") {
    await scheduledPostQueue.add(
      "publish",
      { scheduledPostId: scheduledPost.id },
      {
        delay: Math.max(0, input.scheduledAt.getTime() - Date.now()),
        attempts: 3,
        backoff: { type: "exponential", delay: 30000 },
      },
    );
  }

  return { scheduledPost };
}

export function listSchedules(userId: string) {
  return prisma.scheduledPost.findMany({
    where: { userId },
    orderBy: { scheduledAt: "asc" },
    include: {
      video: {
        select: {
          thumbnailUrl: true,
          content: { select: { hook: true, product: { select: { name: true } } } },
        },
      },
    },
  });
}

export async function cancelSchedule(userId: string, id: string) {
  const { count } = await prisma.scheduledPost.updateMany({
    where: { id, userId, status: "scheduled" },
    data: { status: "cancelled" },
  });
  return count > 0;
}
