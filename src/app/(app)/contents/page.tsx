import { headers } from "next/headers";
import Link from "next/link";
import { auth } from "@/lib/auth/auth";
import { listContents } from "@/services/content.service";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { styleLabel } from "@/lib/prompt-engine/style-playbooks";

export default async function ContentsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  const contents = await listContents(session!.user.id);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Content</h1>

      {contents.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center text-muted-foreground">
            <p>ยังไม่มีคอนเทนต์ที่สร้างไว้</p>
            <p className="text-sm">
              ไปที่หน้าสินค้า แล้วกด &quot;สร้าง Hook/Script/Caption&quot;
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {contents.map((c) => (
            <Link key={c.id} href={`/contents/${c.id}`}>
              <Card className="h-full transition-colors hover:bg-muted/50">
                <CardContent className="flex flex-col gap-2 pt-6">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium">{c.product.name}</p>
                    <Badge variant="secondary">{styleLabel(c.style).name}</Badge>
                  </div>
                  <p className="line-clamp-2 text-sm text-muted-foreground">
                    {c.hook}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
