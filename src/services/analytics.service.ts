import { prisma } from "@/lib/db/prisma";

export async function getAnalytics(userId: string) {
  const [
    productsCount,
    contentsCount,
    videosTotal,
    videosCompleted,
    videosFailed,
    creditsNet,
    completedVideos,
  ] = await Promise.all([
    prisma.product.count({ where: { userId } }),
    prisma.content.count({ where: { userId } }),
    prisma.video.count({ where: { userId } }),
    prisma.video.count({ where: { userId, status: "completed" } }),
    prisma.video.count({ where: { userId, status: "failed" } }),
    prisma.creditTransaction.aggregate({
      where: { userId },
      _sum: { amount: true },
    }),
    prisma.video.findMany({
      where: { userId, status: "completed" },
      select: { createdAt: true, updatedAt: true },
    }),
  ]);

  const successRate = videosTotal > 0 ? (videosCompleted / videosTotal) * 100 : 0;
  // Debits are negative, refunds are positive — the net sum is what was
  // actually consumed (a failed-then-refunded video nets to zero).
  const creditsUsed = Math.max(0, -(creditsNet._sum.amount ?? 0));

  const avgGenerationMs =
    completedVideos.length > 0
      ? completedVideos.reduce(
          (sum, v) => sum + (v.updatedAt.getTime() - v.createdAt.getTime()),
          0,
        ) / completedVideos.length
      : 0;

  return {
    productsCount,
    contentsCount,
    videosTotal,
    videosCompleted,
    videosFailed,
    successRate,
    creditsUsed,
    avgGenerationSeconds: Math.round(avgGenerationMs / 1000),
  };
}
