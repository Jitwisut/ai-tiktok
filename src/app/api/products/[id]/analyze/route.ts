import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth/auth";
import { analyzeProduct } from "@/services/analysis.service";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const analysis = await analyzeProduct(session.user.id, id);
    if (!analysis) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ analysis });
  } catch (err) {
    const message = err instanceof Error ? err.message : "วิเคราะห์สินค้าไม่สำเร็จ";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
