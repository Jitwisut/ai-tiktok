import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth/auth";
import { cancelSchedule } from "@/services/scheduled-post.service";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const cancelled = await cancelSchedule(session.user.id, id);
  if (!cancelled) {
    return NextResponse.json(
      { error: "ไม่พบ หรือไม่สามารถยกเลิกได้ (อาจโพสต์ไปแล้ว)" },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true });
}
