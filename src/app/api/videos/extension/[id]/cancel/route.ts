import { rm } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";

const CLIP_DIR = path.join(process.cwd(), "public", "generated-videos", "clips");

/**
 * Abandons a half-finished extension job. Clips already uploaded are thrown
 * away — they are fragments of a video that will never be assembled, and
 * leaving them would make a later run concatenate parts of two attempts.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = process.env.EXTENSION_UPLOAD_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "EXTENSION_UPLOAD_TOKEN is not set" }, { status: 503 });
  }
  if (request.headers.get("x-extension-token") !== token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const video = await prisma.video.findUnique({ where: { id } });
  if (!video) {
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  }
  if (video.status === "completed") {
    return NextResponse.json({ error: "วิดีโอนี้สร้างเสร็จแล้ว ยกเลิกไม่ได้" }, { status: 409 });
  }

  await prisma.videoClip.deleteMany({ where: { videoId: id } });
  await rm(path.join(CLIP_DIR, id), { recursive: true, force: true }).catch(() => {});

  const updated = await prisma.video.update({
    where: { id },
    data: { status: "cancelled", errorMessage: "ยกเลิกโดยผู้ใช้" },
  });

  return NextResponse.json({ video: updated });
}
