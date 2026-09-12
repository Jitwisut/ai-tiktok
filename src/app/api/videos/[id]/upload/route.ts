import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;
const OUTPUT_DIR = path.join(process.cwd(), "public", "generated-videos");

/**
 * Receives a finished video file from the Chrome extension after it drives
 * Google AI Studio's web UI to generate one manually. Authenticated with a
 * shared-secret header (not the user session) because the caller is the
 * extension's background service worker, not the browser tab — there is no
 * session cookie to forward across that boundary.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = process.env.EXTENSION_UPLOAD_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "EXTENSION_UPLOAD_TOKEN is not set" }, { status: 503 });
  }

  const providedToken = request.headers.get("x-extension-token");
  if (providedToken !== token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const video = await prisma.video.findUnique({ where: { id } });
  if (!video) {
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
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

  await mkdir(OUTPUT_DIR, { recursive: true });
  const filename = `${randomUUID()}.mp4`;
  await writeFile(path.join(OUTPUT_DIR, filename), buffer);

  const updated = await prisma.video.update({
    where: { id },
    data: {
      status: "completed",
      videoUrl: `/generated-videos/${filename}`,
      errorMessage: null,
    },
  });

  return NextResponse.json({ video: updated });
}
