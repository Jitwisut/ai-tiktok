import { prisma } from "@/lib/db/prisma";
import { videoQueue } from "@/lib/queue/video-queue";
import { buildVeoPrompt } from "@/lib/prompt-engine/prompt-builder";
import { CLIP_SECONDS, planClips } from "@/lib/prompt-engine/clip-planner";
import { videoSettingsSchema, type VideoSettings } from "@/lib/prompt-engine/types";

export const VIDEO_CREDIT_COST = 20;

export async function createVideo(
  userId: string,
  contentId: string,
  settings: VideoSettings,
) {
  const content = await prisma.content.findFirst({
    where: { id: contentId, userId },
    include: { product: true, scenes: { orderBy: { position: "asc" } } },
  });
  if (!content) return { error: "not_found" as const };
  if (content.scenes.length === 0) return { error: "no_scenes" as const };

  const promptSettings = {
    ...settings,
    style: settings.style === "UGC" ? content.style : settings.style,
    // Content-level text is the source of truth, while explicit settings let
    // an API caller override it for a one-off render.
    onScreenText: settings.onScreenText ?? content.onScreenText ?? undefined,
    onScreenCta: settings.onScreenCta ?? content.onScreenCta ?? undefined,
  };
  const built = buildVeoPrompt(content.product.name, content.scenes, promptSettings);

  const video = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.credits < VIDEO_CREDIT_COST) {
      throw new Error("INSUFFICIENT_CREDITS");
    }

    await tx.user.update({
      where: { id: userId },
      data: { credits: { decrement: VIDEO_CREDIT_COST } },
    });

    await tx.creditTransaction.create({
      data: {
        userId,
        type: "debit",
        amount: -VIDEO_CREDIT_COST,
        referenceId: contentId,
        description: `Video generation for content ${contentId}`,
      },
    });

    return tx.video.create({
      data: {
        userId,
        contentId,
        provider: process.env.VIDEO_PROVIDER ?? "mock",
        status: "queued",
        aspectRatio: settings.aspectRatio,
        duration: settings.duration,
        settings: JSON.parse(
          JSON.stringify({ ...promptSettings, promptText: built.text, structured: built.structured }),
        ),
      },
    });
  }).catch((err) => {
    if (err instanceof Error && err.message === "INSUFFICIENT_CREDITS") {
      return null;
    }
    throw err;
  });

  if (!video) return { error: "insufficient_credits" as const };

  await videoQueue.add(
    "generate",
    { videoId: video.id },
    { attempts: 3, backoff: { type: "custom" } },
  );

  return { video };
}

/**
 * Alternate path for users generating video manually through Google AI
 * Studio's web UI (via the browser extension) instead of the app's own
 * VIDEO_PROVIDER. No credit deduction and no queue job — the extension
 * does the generation and POSTs the finished file to the upload route,
 * which flips this row to completed.
 */
export async function createExtensionVideoJob(
  userId: string,
  contentId: string,
  settings: VideoSettings,
  targetDuration: number = CLIP_SECONDS,
) {
  const content = await prisma.content.findFirst({
    where: { id: contentId, userId },
    include: {
      product: { include: { images: { orderBy: { position: "asc" }, take: 1 } } },
      scenes: { orderBy: { position: "asc" } },
    },
  });
  if (!content) return { error: "not_found" as const };
  if (content.scenes.length === 0) return { error: "no_scenes" as const };

  const promptSettings = {
    ...settings,
    style: settings.style === "UGC" ? content.style : settings.style,
    onScreenText: content.onScreenText ?? settings.onScreenText ?? undefined,
    onScreenCta: content.onScreenCta ?? settings.onScreenCta ?? undefined,
  };
  const clips = planClips({
    productName: content.product.name,
    scenes: content.scenes,
    settings: promptSettings,
    targetDuration,
    text: { headline: promptSettings.onScreenText, cta: promptSettings.onScreenCta },
  });

  const video = await prisma.video.create({
    data: {
      userId,
      contentId,
      provider: "extension",
      status: "queued",
      aspectRatio: settings.aspectRatio,
      duration: clips.length * CLIP_SECONDS,
      settings: JSON.parse(JSON.stringify({ ...promptSettings, targetDuration, clips })),
    },
  });

  return { video, clips, imageUrl: content.product.images[0]?.url ?? null };
}

/**
 * Rewrites a queued extension job's clip plan for a different length, so the
 * user can pick the duration from the extension popup at run time instead of
 * having to recreate the job in the app.
 */
export async function replanExtensionVideoClips(videoId: string, targetDuration: number) {
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    include: {
      content: {
        include: {
          product: true,
          scenes: { orderBy: { position: "asc" } },
        },
      },
    },
  });
  if (!video || video.provider !== "extension") return { error: "not_found" as const };
  if (video.status !== "queued") return { error: "not_queued" as const };

  const settings = videoSettingsSchema.parse((video.settings as Record<string, unknown>) ?? {});
  const promptSettings = {
    ...settings,
    style: settings.style === "UGC" ? video.content.style : settings.style,
    onScreenText: video.content.onScreenText ?? settings.onScreenText ?? undefined,
    onScreenCta: video.content.onScreenCta ?? settings.onScreenCta ?? undefined,
  };
  const clips = planClips({
    productName: video.content.product.name,
    scenes: video.content.scenes,
    settings: promptSettings,
    targetDuration,
    text: {
      headline: promptSettings.onScreenText,
      cta: promptSettings.onScreenCta,
    },
  });

  await prisma.video.update({
    where: { id: videoId },
    data: {
      duration: clips.length * CLIP_SECONDS,
      settings: JSON.parse(JSON.stringify({ ...promptSettings, targetDuration, clips })),
    },
  });

  return { clips };
}

export function listVideos(userId: string) {
  return prisma.video.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { content: { select: { hook: true, product: { select: { name: true } } } } },
  });
}

export function getVideo(userId: string, videoId: string) {
  return prisma.video.findFirst({
    where: { id: videoId, userId },
    include: { content: { select: { hook: true, product: { select: { name: true } } } } },
  });
}

export function listVideosForContent(userId: string, contentId: string) {
  return prisma.video.findMany({
    where: { userId, contentId },
    orderBy: { createdAt: "desc" },
  });
}

export async function retryVideo(userId: string, videoId: string) {
  const video = await prisma.video.findFirst({
    where: { id: videoId, userId, status: "failed" },
  });
  if (!video) return null;

  await prisma.video.update({
    where: { id: videoId },
    data: { status: "queued", errorMessage: null },
  });

  await videoQueue.add(
    "generate",
    { videoId },
    { attempts: 3, backoff: { type: "custom" } },
  );

  return video;
}

export async function deleteVideo(userId: string, videoId: string) {
  const { count } = await prisma.video.deleteMany({
    where: { id: videoId, userId },
  });
  return count > 0;
}
