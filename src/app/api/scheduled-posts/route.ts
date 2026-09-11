import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth/auth";
import { createScheduledPostSchema } from "@/lib/validation/scheduled-post";
import { createSchedule, listSchedules } from "@/services/scheduled-post.service";

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const scheduledPosts = await listSchedules(session.user.id);
  return NextResponse.json({ scheduledPosts });
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const parsed = createScheduledPostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const result = await createSchedule(session.user.id, parsed.data);
  if ("error" in result) {
    return NextResponse.json(
      { error: "ต้องเป็นวิดีโอที่สร้างเสร็จแล้วเท่านั้น" },
      { status: 400 },
    );
  }

  return NextResponse.json({ scheduledPost: result.scheduledPost }, { status: 201 });
}
