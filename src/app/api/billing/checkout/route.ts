import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth/auth";
import { createCheckoutSchema } from "@/lib/validation/billing";
import { createCheckoutSession } from "@/services/billing.service";

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const parsed = createCheckoutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await createCheckoutSession(
      session.user.id,
      parsed.data.packageId,
      request.nextUrl.origin,
    );
    if ("error" in result) {
      return NextResponse.json({ error: "ไม่พบแพ็กเกจนี้" }, { status: 400 });
    }
    return NextResponse.json({ url: result.url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "สร้างรายการชำระเงินไม่สำเร็จ";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
