import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth/auth";
import { getProduct } from "@/services/product.service";
import { getProductAnalysis } from "@/services/analysis.service";
import { ProductDetailClient } from "./product-detail-client";

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  const product = await getProduct(session!.user.id, id);

  if (!product) {
    notFound();
  }

  const analysis = await getProductAnalysis(session!.user.id, id);

  return (
    <ProductDetailClient
      product={{
        id: product.id,
        name: product.name,
        description: product.description,
        price: product.price?.toString() ?? null,
        currency: product.currency,
        category: product.category,
        sellerName: product.sellerName,
        status: product.status,
        sourceUrl: product.sourceUrl,
        images: product.images.map((img) => ({ id: img.id, url: img.url })),
      }}
      analysis={
        analysis
          ? {
              targetCustomer: analysis.targetCustomer,
              painPoints: analysis.painPoints,
              sellingPoints: analysis.sellingPoints,
              angles: analysis.angles,
            }
          : null
      }
    />
  );
}
