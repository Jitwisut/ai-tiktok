import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { concatClips, removeFiles } from "@/lib/video/concat";

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;
const PUBLIC_DIR = path.join(process.cwd(), "public");
const OUTPUT_DIR = path.join(PUBLIC_DIR, "generated-videos");
const CLIP_DIR = path.join(OUTPUT_DIR, "clips");

/**
 * Receives one finished clip from the Chrome extension after it drives
 * Google AI Studio to generate it. Veo caps a render at 8 seconds, so a
 * longer video arrives as several clips; the final clip triggers the
 * concatenation that produces the video the app actually serves.
 *
 * Authenticated with a shared-secret header rather than the user session:
 * the caller is the extension's background worker, which has no app cookie.
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

  const clipIndex = Number(request.nextUrl.searchParams.get("clip") ?? 0);
  const clipTotal = Number(request.nextUrl.searchParams.get("total") ?? 1);
  if (!Number.isInteger(clipIndex) || !Number.isInteger(clipTotal) || clipTotal < 1 || clipIndex < 0) {
    return NextResponse.json({ error: "Invalid clip index" }, { status: 400 });
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_UPLOAD_SIZE) {
    return NextResponse.json({ error: "File too large" }, { status: 413 });
  }

  const buffer = Buffer.from(await request.arrayBuffer());
  if (buffer.byteLength === 0) {
    return NextResponse.json({ error: "Empty file" }, { status: 400 });
  }
  if (buffer.byteLength > MAX_UPLOAD_SIZE) {
    return NextResponse.json({ error: "File too large" }, { status: 413 });
  }

  const clipDir = path.join(CLIP_DIR, id);
  await mkdir(clipDir, { recursive: true });
  const clipName = `${clipIndex}-${randomUUID()}.mp4`;
  await writeFile(path.join(clipDir, clipName), buffer);

  const clipUrl = `/generated-videos/clips/${id}/${clipName}`;
  await prisma.videoClip.upsert({
    where: { videoId_index: { videoId: id, index: clipIndex } },
    create: { videoId: id, index: clipIndex, url: clipUrl },
    update: { url: clipUrl },
  });

  const clips = await prisma.videoClip.findMany({
    where: { videoId: id },
    orderBy: { index: "asc" },
  });

  if (clips.length < clipTotal) {
    await prisma.video.update({ where: { id }, data: { status: "processing" } });
    return NextResponse.json({ received: clips.length, total: clipTotal, done: false });
  }

  const clipPaths = clips.map((clip) => path.join(PUBLIC_DIR, clip.url));
  try {
    const filename = await concatClips(clipPaths, OUTPUT_DIR, video.aspectRatio ?? "9:16");
    await removeFiles(clipPaths);
    await prisma.videoClip.deleteMany({ where: { videoId: id } });

    const updated = await prisma.video.update({
      where: { id },
      data: {
        status: "completed",
        videoUrl: `/generated-videos/${filename}`,
        errorMessage: null,
      },
    });
    return NextResponse.json({ video: updated, done: true, clips: clipTotal });
  } catch (err) {
    const message = err instanceof Error ? err.message : "concat failed";
    await prisma.video.update({
      where: { id },
      data: { status: "failed", errorMessage: `ต่อคลิปไม่สำเร็จ: ${message}` },
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
