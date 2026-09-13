import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { importTikTokProductsSchema } from "@/lib/validation/product";
import { deleteProducts, importTikTokProducts, listProducts } from "@/services/product.service";

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

async function getSingleUser() {
  return prisma.user.findFirst({ select: { id: true } });
}

/** Feeds the panel's product table. */
export async function GET(request: NextRequest) {
  const denied = unauthorized(request);
  if (denied) return denied;

  const user = await getSingleUser();
  if (!user) return NextResponse.json({ products: [] });

  const products = await listProducts(user.id);
  const origin = request.nextUrl.origin;
  return NextResponse.json({
    products: products.map((product) => {
      const image = product.images[0]?.url;
      return {
        id: product.id,
        name: product.name,
        description: product.description,
        price: product.price,
        status: product.status,
        source: product.source,
        sourceUrl: product.sourceUrl,
        image: image ? (image.startsWith("http") ? image : `${origin}${image}`) : null,
      };
    }),
  });
}

/** Bulk delete for the panel's selection row. */
export async function DELETE(request: NextRequest) {
  const denied = unauthorized(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const ids = Array.isArray(body?.ids)
    ? body.ids.filter((id: unknown): id is string => typeof id === "string")
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "ids is required" }, { status: 400 });
  }

  const user = await getSingleUser();
  if (!user) {
    return NextResponse.json({ error: "No user found" }, { status: 500 });
  }

  const count = await deleteProducts(user.id, ids);
  return NextResponse.json({ ok: true, count });
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
