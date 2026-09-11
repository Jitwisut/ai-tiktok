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
      scheduledAt: input.scheduledAt,
    },
  });

  await scheduledPostQueue.add(
    "publish",
    { scheduledPostId: scheduledPost.id },
    { delay: Math.max(0, input.scheduledAt.getTime() - Date.now()) },
  );

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
