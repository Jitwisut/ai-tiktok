import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth/auth";
import { generateContentSchema } from "@/lib/validation/content";
import { generateContent } from "@/services/content.service";

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const parsed = generateContentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const content = await generateContent(
      session.user.id,
      parsed.data.productId,
      parsed.data.style,
      parsed.data.targetDuration,
    );
    if (!content) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ content }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "สร้างคอนเทนต์ไม่สำเร็จ";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
