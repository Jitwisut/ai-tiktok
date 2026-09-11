import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth/auth";
import { retryVideo } from "@/services/video.service";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const video = await retryVideo(session.user.id, id);
  if (!video) {
    return NextResponse.json(
      { error: "ไม่พบวิดีโอ หรือวิดีโอไม่ได้อยู่ในสถานะ failed" },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true });
}
