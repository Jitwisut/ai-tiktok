import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth/auth";
import { createVideoSchema } from "@/lib/validation/video";
import { videoSettingsSchema } from "@/lib/prompt-engine/types";
import { createExtensionVideoJob } from "@/services/video.service";

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const parsed = createVideoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const settings = videoSettingsSchema.parse(parsed.data.settings ?? {});
  const result = await createExtensionVideoJob(session.user.id, parsed.data.contentId, settings);

  if ("error" in result) {
    const message =
      result.error === "no_scenes" ? "ต้องสร้าง Scene ก่อนจึงจะสร้างวิดีโอได้" : "ไม่พบคอนเทนต์";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  return NextResponse.json(
    { video: result.video, prompt: result.prompt, imageUrl: result.imageUrl },
    { status: 201 },
  );
}
