import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";

/**
 * Lists video jobs waiting for the extension to generate them in AI Studio.
 * Token-gated like the upload route — the caller is the extension popup, an
 * extension-origin page with no app session cookie to send.
 */
export async function GET(request: NextRequest) {
  const token = process.env.EXTENSION_UPLOAD_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "EXTENSION_UPLOAD_TOKEN is not set" }, { status: 503 });
  }
  if (request.headers.get("x-extension-token") !== token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const videos = await prisma.video.findMany({
    where: { provider: "extension", status: { in: ["queued", "processing"] } },
    orderBy: { createdAt: "desc" },
    take: 20,
    include: {
      content: {
        include: {
          product: { include: { images: { orderBy: { position: "asc" }, take: 1 } } },
        },
      },
    },
  });

  const jobs = videos.map((video) => {
    const settings = video.settings as {
      clips?: { index: number; prompt: string }[];
      promptText?: string;
    };
    // Older rows predate clip planning and carry a single prompt.
    const clips = settings?.clips ?? [{ index: 0, prompt: settings?.promptText ?? "" }];

    return {
      videoId: video.id,
      productName: video.content.product.name,
      hook: video.content.hook,
      clips,
      imageUrl: video.content.product.images[0]?.url ?? null,
      duration: video.duration,
      aspectRatio: video.aspectRatio,
    };
  });

  return NextResponse.json({ jobs });
}
