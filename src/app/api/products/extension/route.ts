import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { importTikTokProductsSchema } from "@/lib/validation/product";
import { importTikTokProducts } from "@/services/product.service";

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

/**
 * Bulk product import from the TikTok Studio cart selection. Token-gated
 * like the other extension routes — there's no session here, so ownership
 * falls to this app's one user rather than anything the request carries.
 */
export async function POST(request: NextRequest) {
  const denied = unauthorized(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const parsed = importTikTokProductsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) {
    return NextResponse.json({ error: "No user found" }, { status: 500 });
  }

  const products = await importTikTokProducts(user.id, parsed.data.products);
  return NextResponse.json({ products }, { status: 201 });
}
