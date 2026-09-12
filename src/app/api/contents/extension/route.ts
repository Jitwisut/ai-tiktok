import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { createExtensionVideoJob } from "@/services/video.service";
import { videoSettingsSchema } from "@/lib/prompt-engine/types";
import { SUPPORTED_TARGET_DURATIONS } from "@/lib/prompt-engine/clip-planner";

function unauthorized(request: NextRequest) {
  const token = process.env.EXTENSION_UPLOAD_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "EXTENSION_UPLOAD_TOKEN is not set" }, { status: 503 });
  }
  if (request.headers.get("x-extension-token") !== token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

/** Content ready to be filmed, so the extension panel can offer it directly. */
export async function GET(request: NextRequest) {
  const denied = unauthorized(request);
  if (denied) return denied;

  const contents = await prisma.content.findMany({
    where: { scenes: { some: {} } },
    orderBy: { createdAt: "desc" },
    take: 20,
    include: {
      product: { include: { images: { orderBy: { position: "asc" }, take: 1 } } },
      _count: { select: { scenes: true } },
    },
  });

  const origin = request.nextUrl.origin;
  return NextResponse.json({
    contents: contents.map((content) => {
      // Uploaded images are stored as app-relative paths; imported ones are
      // already absolute. The panel needs something it can put in an <img>.
      const image = content.product.images[0]?.url;
      return {
        contentId: content.id,
        productName: content.product.name,
        hook: content.hook,
        sceneCount: content._count.scenes,
        imageUrl: image ? (image.startsWith("http") ? image : `${origin}${image}`) : null,
      };
    }),
  });
}

/**
 * Starts a job from the panel. Token-gated rather than session-gated like the
 * app's own route, so the owner comes from the content record itself.
 */
export async function POST(request: NextRequest) {
  const denied = unauthorized(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const contentId = typeof body?.contentId === "string" ? body.contentId : "";
  const targetDuration = Number(body?.targetDuration ?? 24);

  if (!contentId) {
    return NextResponse.json({ error: "contentId is required" }, { status: 400 });
  }
  if (!SUPPORTED_TARGET_DURATIONS.includes(targetDuration as never)) {
    return NextResponse.json(
      { error: `targetDuration must be one of ${SUPPORTED_TARGET_DURATIONS.join(", ")}` },
      { status: 400 },
    );
  }

  const content = await prisma.content.findUnique({ where: { id: contentId } });
  if (!content) {
    return NextResponse.json({ error: "Content not found" }, { status: 404 });
  }

  const settings = videoSettingsSchema.parse({});
  const result = await createExtensionVideoJob(
    content.userId,
    contentId,
    settings,
    targetDuration,
  );
  if ("error" in result) {
    const message =
      result.error === "no_scenes" ? "ต้องสร้าง Scene ก่อนจึงจะสร้างวิดีโอได้" : "ไม่พบคอนเทนต์";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  return NextResponse.json(
    { video: result.video, clips: result.clips, imageUrl: result.imageUrl },
    { status: 201 },
  );
}
