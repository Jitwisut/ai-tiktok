import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { generateContent } from "@/services/content.service";
import { planScenes } from "@/services/scene.service";
import { SUPPORTED_TARGET_DURATIONS } from "@/lib/prompt-engine/clip-planner";
import { CONTENT_STYLES, contentStyleSchema } from "@/lib/validation/content";

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

/**
 * Step 2 of the panel's review flow: generates Content (hook/script/caption/
 * cta) and plans its scenes, but stops short of creating a video job — the
 * panel shows this for review before the user commits to "สร้างวิดีโอ",
 * which calls the existing /api/contents/extension (contentId + duration).
 */
export async function POST(request: NextRequest) {
  const denied = unauthorized(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const productId = typeof body?.productId === "string" ? body.productId : "";
  const targetDuration = Number(body?.targetDuration ?? 24);

  if (!productId) {
    return NextResponse.json({ error: "productId is required" }, { status: 400 });
  }
  const styleResult = contentStyleSchema.safeParse(body?.style);
  if (!styleResult.success) {
    return NextResponse.json(
      { error: `style must be one of ${CONTENT_STYLES.join(", ")}` },
      { status: 400 },
    );
  }
  if (!SUPPORTED_TARGET_DURATIONS.includes(targetDuration as never)) {
    return NextResponse.json(
      { error: `targetDuration must be one of ${SUPPORTED_TARGET_DURATIONS.join(", ")}` },
      { status: 400 },
    );
  }

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { userId: true },
  });
  if (!product) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }

  try {
    const content = await generateContent(product.userId, productId, styleResult.data, targetDuration);
    if (!content) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }
    const scenes = await planScenes(product.userId, content.id, targetDuration);

    return NextResponse.json({
      content: {
        id: content.id,
        hook: content.hook,
        script: content.script,
        caption: content.caption,
        cta: content.cta,
        onScreenText: content.onScreenText,
        onScreenCta: content.onScreenCta,
        angle: content.angle,
      },
      scenes: (scenes ?? []).map((scene) => ({
        duration: scene.duration,
        description: scene.description,
        visual: scene.visual,
        cameraMotion: scene.cameraMotion,
        clip: scene.clip,
        dialogue: scene.dialogue,
        voiceover: scene.voiceover,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "สร้างคอนเทนต์ไม่สำเร็จ";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
