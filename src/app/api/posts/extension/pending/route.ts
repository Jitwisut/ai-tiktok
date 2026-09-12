import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";

/**
 * Posts the extension should publish now — scheduled for extension delivery
 * and already due. Token-gated like the other extension routes, since the
 * caller is an extension context with no app session cookie.
 */
export async function GET(request: NextRequest) {
  const token = process.env.EXTENSION_UPLOAD_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "EXTENSION_UPLOAD_TOKEN is not set" }, { status: 503 });
  }
  if (request.headers.get("x-extension-token") !== token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const origin = request.nextUrl.origin;
  const posts = await prisma.scheduledPost.findMany({
    where: {
      method: "extension",
      status: "scheduled",
      scheduledAt: { lte: new Date() },
      video: { status: "completed", videoUrl: { not: null } },
    },
    orderBy: { scheduledAt: "asc" },
    take: 10,
    include: { video: { include: { content: { include: { product: true } } } } },
  });

  return NextResponse.json({
    posts: posts.map((post) => ({
      postId: post.id,
      platform: post.platform,
      productName: post.video.content.product.name,
      // Absolute so the extension can fetch it from another origin.
      videoUrl: `${origin}${post.video.videoUrl}`,
      caption: `${post.video.content.caption}\n\n${post.video.content.cta}`,
      scheduledAt: post.scheduledAt,
    })),
  });
}
