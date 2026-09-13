import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { analyzeProduct } from "@/services/analysis.service";

function unauthorized(request: NextRequest) {
  const token = process.env.EXTENSION_UPLOAD_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "EXTENSION_UPLOAD_TOKEN is not set" }, { status: 503 });
  }
  if (request.headers.get("x-extension-token") !== token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

/** Step 1 of the panel's review flow: target customer / pain points / selling points / angles. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = unauthorized(request);
  if (denied) return denied;

  const { id } = await params;
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) {
    return NextResponse.json({ error: "No user found" }, { status: 500 });
  }

  try {
    const analysis = await analyzeProduct(user.id, id);
    if (!analysis) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }
    return NextResponse.json({ analysis });
  } catch (err) {
    const message = err instanceof Error ? err.message : "วิเคราะห์สินค้าไม่สำเร็จ";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
