import { headers } from "next/headers";
import Link from "next/link";
import { auth } from "@/lib/auth/auth";
import { listProducts } from "@/services/product.service";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default async function ProductsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  const products = await listProducts(session!.user.id);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Products</h1>
        <Button nativeButton={false} render={<Link href="/products/new">+ เพิ่มสินค้า</Link>} />
      </div>

      {products.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center text-muted-foreground">
            <p>ยังไม่มีสินค้าในระบบ</p>
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link href="/products/new">เพิ่มสินค้าแรกของคุณ</Link>}
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((p) => (
            <Link key={p.id} href={`/products/${p.id}`}>
              <Card className="h-full transition-colors hover:bg-muted/50">
                {p.images[0] && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.images[0].url}
                    alt={p.name}
                    className="aspect-video w-full rounded-t-xl object-cover"
                  />
                )}
                <CardContent className="flex flex-col gap-2 pt-6">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium">{p.name}</p>
                    <Badge variant="secondary">{p.status}</Badge>
                  </div>
                  {p.description && (
                    <p className="line-clamp-2 text-sm text-muted-foreground">
                      {p.description}
                    </p>
                  )}
                  {p.price && (
                    <p className="text-sm font-medium">
                      {p.currency ?? ""} {p.price.toString()}
                    </p>
                  )}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
