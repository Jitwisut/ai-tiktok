import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";

/** The extension reports back what happened after driving the web uploader. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = process.env.EXTENSION_UPLOAD_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "EXTENSION_UPLOAD_TOKEN is not set" }, { status: 503 });
  }
  if (request.headers.get("x-extension-token") !== token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const status = body?.status;
  if (status !== "posted" && status !== "failed") {
    return NextResponse.json({ error: "status must be posted or failed" }, { status: 400 });
  }

  const { id } = await params;
  const post = await prisma.scheduledPost.findUnique({ where: { id } });
  if (!post) {
    return NextResponse.json({ error: "Post not found" }, { status: 404 });
  }

  const updated = await prisma.scheduledPost.update({
    where: { id },
    data: {
      status,
      platformPostId: typeof body?.platformPostId === "string" ? body.platformPostId : null,
      error: status === "failed" ? (body?.error ?? "โพสต์ไม่สำเร็จ") : null,
    },
  });

  return NextResponse.json({ post: updated });
}
