import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth/auth";
import { planScenesInputSchema } from "@/lib/validation/scene";
import { planScenes } from "@/services/scene.service";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const parsed = planScenesInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const scenes = await planScenes(session.user.id, id, parsed.data.targetDuration);
    if (!scenes) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ scenes });
  } catch (err) {
    const message = err instanceof Error ? err.message : "สร้างฉากไม่สำเร็จ";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
