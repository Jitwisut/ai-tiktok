import { NextRequest, NextResponse } from "next/server";
import { replanExtensionVideoClips } from "@/services/video.service";
import { SUPPORTED_TARGET_DURATIONS } from "@/lib/prompt-engine/clip-planner";

/**
 * Re-plans a queued job's clips for a new length. Token-gated because the
 * caller is the extension popup, where the user picks the duration.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = process.env.EXTENSION_UPLOAD_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "EXTENSION_UPLOAD_TOKEN is not set" }, { status: 503 });
  }
  if (request.headers.get("x-extension-token") !== token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const targetDuration = Number(body?.targetDuration);
  if (!SUPPORTED_TARGET_DURATIONS.includes(targetDuration as never)) {
    return NextResponse.json(
      { error: `targetDuration must be one of ${SUPPORTED_TARGET_DURATIONS.join(", ")}` },
      { status: 400 },
    );
  }

  const { id } = await params;
  const result = await replanExtensionVideoClips(id, targetDuration);
  if ("error" in result) {
    const status = result.error === "not_found" ? 404 : 409;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json({ clips: result.clips });
}
